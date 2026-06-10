'use strict';
// Records a player's wager server-side after they deposit on-chain.
// 1. Verifies their wallet signature (proves they own the wallet).
// 2. Verifies the on-chain tx (proves they actually paid).
// 3. Stores wallet → wagerLamports in KV (settle.js reads this at cashout time).

const nacl = require('tweetnacl');
const { kvGet, kvSet } = require('./kv');

const ESCROW_PUBKEY = '2SYFfCsSmKr8qwK1AfWd36JtAc1BCaRaSSxyECKUJjBb';
const RPCS = [
  process.env.HELIUS_RPC_URL,
  'https://api.mainnet-beta.solana.com',
  'https://try-rpc.mainnet-beta.solana.com',
  'https://solana.public-rpc.com',
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Decode(str) {
  const b = [];
  for (const c of str) {
    let v = B58.indexOf(c); if (v < 0) throw new Error('Bad base58');
    for (let i = 0; i < b.length; i++) { v += b[i] * 58; b[i] = v & 0xff; v >>= 8; }
    while (v > 0) { b.push(v & 0xff); v >>= 8; }
  }
  let z = 0; for (const c of str) { if (c !== '1') break; z++; }
  const out = new Uint8Array(z + b.length);
  b.reverse().forEach((x, i) => { out[z + i] = x; });
  return out;
}

async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const one  = async url => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.result;
  };
  for (let i = 0; i <= 2; i++) {
    if (i > 0) await sleep(800 * i);
    try { return await Promise.any(RPCS.map(one)); } catch (_) {}
  }
  throw new Error('All RPCs failed');
}

function verifyPlayerSig(sig, ts, action, playerAddress, wagerLamports) {
  try {
    const now = Math.floor(Date.now() / 1000);
    if (!sig || !ts) return false;
    if (Math.abs(now - Number(ts)) > 120) return false;
    const msg = 'pac-arena:' + action + ':' + (playerAddress || '') + ':' + (wagerLamports || 0) + ':' + ts;
    return nacl.sign.detached.verify(Buffer.from(msg, 'utf8'), Buffer.from(sig, 'base64'), b58Decode(playerAddress));
  } catch (_) { return false; }
}

// Confirms txSig paid at least wagerLamports to ESCROW_PUBKEY from walletAddress.
async function verifyWagerTx(txSig, walletAddress, wagerLamports) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const tx = await rpcCall('getTransaction', [txSig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!tx) continue; // not indexed yet — retry
      if (tx.meta && tx.meta.err) throw new Error('Transaction failed on-chain');

      const keys = tx.transaction.message.accountKeys;
      const getKey = k => (typeof k === 'string' ? k : k.pubkey);
      const escrowIdx = keys.findIndex(k => getKey(k) === ESCROW_PUBKEY);
      if (escrowIdx < 0) throw new Error('Escrow address not found in transaction');

      const received = tx.meta.postBalances[escrowIdx] - tx.meta.preBalances[escrowIdx];
      if (received < wagerLamports) throw new Error('Payment too small: got ' + received + ' need ' + wagerLamports);

      // Also confirm the sender is the wallet that signed this request
      const senderIdx = keys.findIndex(k => getKey(k) === walletAddress);
      if (senderIdx < 0) throw new Error('Sender wallet not found in transaction');

      return; // verified ✓
    } catch (e) {
      if (e.message.startsWith('Payment too small') || e.message.startsWith('Escrow') || e.message.startsWith('Sender') || e.message.startsWith('Transaction failed')) throw e;
      // not indexed yet — keep retrying
    }
  }
  throw new Error('Transaction not confirmed — try again in a moment');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-settle-sig, x-settle-ts');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    let body = req.body;
    if (typeof body === 'string') try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'Bad JSON' }); }
    body = body || {};

    const { walletAddress, wagerLamports, txSig } = body;
    const sig = req.headers['x-settle-sig'] || '';
    const ts  = req.headers['x-settle-ts']  || '';
    const lamps = Number(wagerLamports) || 0;

    if (!walletAddress)  return res.status(400).json({ error: 'walletAddress required' });
    if (lamps <= 0)      return res.status(400).json({ error: 'wagerLamports must be positive' });
    if (!txSig)          return res.status(400).json({ error: 'txSig required' });

    // Wallet signature proves the player owns the wallet making this claim
    if (!verifyPlayerSig(sig, ts, 'join', walletAddress, lamps)) {
      return res.status(403).json({ error: 'Invalid wallet signature' });
    }

    // Replay guard — reject re-use of a txSig that was already registered.
    // After cashout the KV wager entry is deleted, but an attacker could re-submit
    // the same old txSig to recreate it and cashout again from other players' funds.
    // We store tx:{txSig} for 24h so replays are blocked even after cashout.
    const txKey = 'tx:' + txSig;
    const alreadyUsed = await kvGet(txKey);
    if (alreadyUsed !== null) {
      return res.status(400).json({ error: 'Transaction already registered — make a new deposit to play again' });
    }

    // On-chain tx proves they actually paid
    await verifyWagerTx(txSig, walletAddress, lamps);

    // Store replay guard (24h) before the wager entry so even a partial failure blocks replay.
    await kvSet(txKey, '1', 86400);
    // Store for 4 hours — more than enough for any game session
    await kvSet('pw:' + walletAddress, lamps, 14400);

    return res.status(200).json({ ok: true, recorded: lamps });
  } catch (e) {
    console.error('[join]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
