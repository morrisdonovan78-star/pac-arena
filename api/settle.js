// api/settle.js — Server-side escrow settlement
// Uses tweetnacl (pure CJS) + raw JSON-RPC. No @solana/web3.js.

'use strict';
const nacl = require('tweetnacl');

const CREATOR_WALLET  = '2ZLqQww5koLr2J7PU54UwA7yNX4DRmMHMLAQjm411E7a';
const CREATOR_FEE_PCT = 0.10;
const TX_FEE          = 5000;   // lamports for a 1-signer tx
const RENT_EXEMPT_MIN = 890880; // lamports minimum to keep an account alive
const RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://solana.public-rpc.com',
];

// ── Base58 helpers ──────────────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Decode(str) {
  const bytes = [];
  for (const ch of str) {
    let val = B58.indexOf(ch);
    if (val < 0) throw new Error('Invalid base58 char: ' + ch);
    for (let i = 0; i < bytes.length; i++) { val += bytes[i] * 58; bytes[i] = val & 0xff; val >>= 8; }
    while (val > 0) { bytes.push(val & 0xff); val >>= 8; }
  }
  let z = 0; for (const ch of str) { if (ch !== '1') break; z++; }
  const out = new Uint8Array(z + bytes.length);
  bytes.reverse().forEach((b, i) => { out[z + i] = b; });
  return out;
}
function b58Encode(u8) {
  const d = [];
  for (const byte of u8) {
    let c = byte;
    for (let i = 0; i < d.length; i++) { c += d[i] * 256; d[i] = c % 58; c = Math.floor(c / 58); }
    while (c > 0) { d.push(c % 58); c = Math.floor(c / 58); }
  }
  let p = ''; for (const b of u8) { if (b !== 0) break; p += '1'; }
  return p + d.reverse().map(x => B58[x]).join('');
}
function cu16(n) {
  if (n < 0x80) return [n];
  if (n < 0x4000) return [(n & 0x7f) | 0x80, (n >> 7) & 0xff];
  return [(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, (n >> 14) & 0xff];
}

// ── Escrow keypair from env var ─────────────────────────────────────────────
function getEscrowKeypair() {
  const raw = (process.env.ESCROW_SECRET || '').replace(/^﻿/, '').trim();
  if (!raw) throw new Error('ESCROW_SECRET env var not set');
  let bytes;
  try { bytes = JSON.parse(raw); } catch (e) {
    throw new Error('ESCROW_SECRET parse failed: ' + e.message);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64)
    throw new Error('ESCROW_SECRET must be 64-element array, got ' + (Array.isArray(bytes) ? bytes.length : typeof bytes));
  const kp = nacl.sign.keyPair.fromSecretKey(new Uint8Array(bytes));
  return { secretKey: kp.secretKey, publicKey: kp.publicKey, pubkeyB58: b58Encode(kp.publicKey) };
}

// ── RPC: race all 3 nodes, 3s timeout each, first success wins ──────────────
async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const tryOne = async function(rpc) {
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error('RPC ' + d.error.code + ': ' + d.error.message);
    return d.result;
  };
  try {
    return await Promise.any(RPCS.map(tryOne));
  } catch (agg) {
    const msgs = (agg.errors || []).map(function(e) { return e.message; }).join('; ');
    throw new Error('All RPCs failed: ' + msgs);
  }
}

// ── Build + sign a Solana transaction (escrow as signer) ────────────────────
function buildSignedTx(kp, blockhash, transfers) {
  const SYS = new Uint8Array(32);
  const accts = [kp.publicKey];
  for (const t of transfers) {
    if (!accts.some(a => a.every((v, i) => v === t.toPubkeyBytes[i]))) accts.push(t.toPubkeyBytes);
  }
  accts.push(SYS);
  const sysIdx = accts.length - 1;
  const header = [1, 0, 1];
  const keysBuf = [...cu16(accts.length), ...accts.flatMap(a => Array.from(a))];
  const bhBytes = Array.from(b58Decode(blockhash));
  const ixArr = [];
  ixArr.push(...cu16(transfers.length));
  for (const t of transfers) {
    const toIdx = accts.findIndex(a => a.every((v, i) => v === t.toPubkeyBytes[i]));
    const data = new Uint8Array(12);
    data[0] = 2; // SystemProgram.Transfer instruction index
    new DataView(data.buffer).setBigUint64(4, BigInt(t.lamports), true);
    ixArr.push(sysIdx, ...cu16(2), 0, toIdx, ...cu16(data.length), ...Array.from(data));
  }
  const msg = new Uint8Array([...header, ...keysBuf, ...bhBytes, ...ixArr]);
  const sig = nacl.sign.detached(msg, kp.secretKey);
  return new Uint8Array([...cu16(1), ...Array.from(sig), ...Array.from(msg)]);
}

// ── Broadcast tx — fire and return sig immediately (no polling) ─────────────
async function sendTx(txBytes) {
  const b64 = Buffer.from(txBytes).toString('base64');
  return await rpcCall('sendTransaction', [b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
}

// ── Main handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Hard 8-second timeout — always returns JSON, never lets Vercel kill us silently
  let finished = false;
  const timeout = setTimeout(function() {
    if (!finished) {
      finished = true;
      try { res.status(500).json({ error: 'Request timed out — RPC nodes slow, try again' }); } catch (_) {}
    }
  }, 8000);

  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { clearTimeout(timeout); finished = true; res.status(200).end(); return; }
    if (req.method !== 'POST')   { clearTimeout(timeout); finished = true; res.status(405).end(); return; }

    var body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { clearTimeout(timeout); finished = true; return res.status(400).json({ error: 'Bad JSON body' }); }
    }
    body = body || {};
    var action        = body.action;
    var playerAddress = body.playerAddress;

    var esc = getEscrowKeypair();

    // ── balance ─────────────────────────────────────────────────────────────
    if (action === 'balance') {
      var balR = await rpcCall('getBalance', [esc.pubkeyB58, { commitment: 'confirmed' }]);
      clearTimeout(timeout); finished = true;
      return res.status(200).json({ balance: balR.value, escrowPubkey: esc.pubkeyB58, solBalance: balR.value / 1e9 });
    }

    // ── cashout / win: 90% → player, 10% → creator ──────────────────────────
    if (action === 'cashout' || action === 'win') {
      if (!playerAddress) { clearTimeout(timeout); finished = true; return res.status(400).json({ error: 'playerAddress required' }); }
      var rC = await Promise.all([
        rpcCall('getBalance',         [esc.pubkeyB58, { commitment: 'confirmed' }]),
        rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]),
      ]);
      var balC       = rC[0].value;
      var availC     = balC - TX_FEE;
      if (availC <= 0) { clearTimeout(timeout); finished = true; return res.status(400).json({ error: 'Escrow empty — no funds to cashout' }); }
      var creatorCut = Math.floor(availC * CREATOR_FEE_PCT);
      var playerCut  = availC - creatorCut;
      var txC = buildSignedTx(esc, rC[1].value.blockhash, [
        { toPubkeyBytes: b58Decode(playerAddress),  lamports: playerCut  },
        { toPubkeyBytes: b58Decode(CREATOR_WALLET), lamports: creatorCut },
      ]);
      var sigC = await sendTx(txC);
      clearTimeout(timeout); finished = true;
      return res.status(200).json({ sig: sigC, playerCut: playerCut, creatorCut: creatorCut });
    }

    // ── kill reward: victim's wager → killer ─────────────────────────────────
    if (action === 'kill') {
      if (!playerAddress || !body.wagerLamports) { clearTimeout(timeout); finished = true; return res.status(400).json({ error: 'playerAddress and wagerLamports required' }); }
      var rK = await Promise.all([
        rpcCall('getBalance',         [esc.pubkeyB58, { commitment: 'confirmed' }]),
        rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]),
      ]);
      var balK  = rK[0].value;
      var availK = balK - TX_FEE;
      if (availK <= 0) { clearTimeout(timeout); finished = true; return res.status(400).json({ error: 'Escrow empty' }); }
      var amount = Math.min(Number(body.wagerLamports), availK);
      if ((availK - amount) > 0 && (availK - amount) < RENT_EXEMPT_MIN) amount = availK;
      var txK = buildSignedTx(esc, rK[1].value.blockhash, [{ toPubkeyBytes: b58Decode(playerAddress), lamports: amount }]);
      var sigK = await sendTx(txK);
      clearTimeout(timeout); finished = true;
      return res.status(200).json({ sig: sigK, amount: amount });
    }

    // ── lose: full escrow → creator ──────────────────────────────────────────
    if (action === 'lose') {
      var rL = await Promise.all([
        rpcCall('getBalance',         [esc.pubkeyB58, { commitment: 'confirmed' }]),
        rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]),
      ]);
      var balL   = rL[0].value;
      var availL = balL - TX_FEE;
      if (availL <= 0) { clearTimeout(timeout); finished = true; return res.status(400).json({ error: 'Escrow empty' }); }
      var txL = buildSignedTx(esc, rL[1].value.blockhash, [{ toPubkeyBytes: b58Decode(CREATOR_WALLET), lamports: availL }]);
      var sigL = await sendTx(txL);
      clearTimeout(timeout); finished = true;
      return res.status(200).json({ sig: sigL, amount: availL });
    }

    clearTimeout(timeout); finished = true;
    res.status(400).json({ error: 'Unknown action. Use: balance | cashout | win | lose | kill' });

  } catch (e) {
    console.error('[settle] error:', e && e.message);
    if (!finished) {
      finished = true;
      clearTimeout(timeout);
      try { res.status(500).json({ error: (e && e.message) || String(e) }); } catch (_) {}
    }
  }
};
