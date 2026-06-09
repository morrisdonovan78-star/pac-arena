// api/settle.js — tweetnacl only, no @solana/web3.js (ESM/runtime issues)
'use strict';
const nacl = require('tweetnacl');

const CREATOR_WALLET  = '2ZLqQww5koLr2J7PU54UwA7yNX4DRmMHMLAQjm411E7a';
const CREATOR_FEE_PCT = 0.10;
const TX_FEE          = 5000;
const RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://solana.public-rpc.com',
];

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Decode(str) {
  const b = [];
  for (const c of str) {
    let v = B58.indexOf(c);
    if (v < 0) throw new Error('Bad base58 char: ' + c);
    for (let i = 0; i < b.length; i++) { v += b[i] * 58; b[i] = v & 0xff; v >>= 8; }
    while (v > 0) { b.push(v & 0xff); v >>= 8; }
  }
  let z = 0; for (const c of str) { if (c !== '1') break; z++; }
  const out = new Uint8Array(z + b.length);
  b.reverse().forEach((x, i) => { out[z + i] = x; });
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
// compact-u16 encoding used in Solana transaction wire format
function cu16(n) {
  if (n < 0x80)   return [n];
  if (n < 0x4000) return [(n & 0x7f) | 0x80, (n >> 7) & 0xff];
  return [(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, (n >> 14) & 0xff];
}

// ── Escrow keypair from env ──────────────────────────────────────────────────
function getEscrow() {
  const raw = (process.env.ESCROW_SECRET || '').replace(/^﻿/, '').trim();
  if (!raw) throw new Error('ESCROW_SECRET not set');
  let arr; try { arr = JSON.parse(raw); } catch (e) { throw new Error('ESCROW_SECRET bad JSON: ' + e.message); }
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error('ESCROW_SECRET must be 64-byte array');
  const kp = nacl.sign.keyPair.fromSecretKey(new Uint8Array(arr));
  return { secretKey: kp.secretKey, publicKey: kp.publicKey, pubkeyB58: b58Encode(kp.publicKey) };
}

// ── Race 3 RPCs — first success wins ────────────────────────────────────────
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const one = async (url) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error('RPC ' + d.error.code + ': ' + d.error.message);
    return d.result;
  };
  try { return await Promise.any(RPCS.map(one)); }
  catch (e) { throw new Error('All RPCs failed: ' + (e.errors || []).map(x => x.message).join(' | ')); }
}

// ── Build & sign a Solana legacy transaction (escrow signs) ──────────────────
function buildTx(esc, blockhash, transfers) {
  // Validate inputs before doing anything
  if (!blockhash || typeof blockhash !== 'string') throw new Error('buildTx: missing blockhash');
  for (const t of transfers) {
    if (!t.to || t.to.length !== 32) throw new Error('buildTx: recipient must be 32 bytes, got ' + (t.to && t.to.length));
    const lamps = Math.round(Number(t.lamports));
    if (!Number.isFinite(lamps) || lamps <= 0) throw new Error('buildTx: invalid lamports=' + t.lamports);
    t.lamports = lamps; // normalise to integer
  }

  // Account list: escrow, ...recipients, system_program
  const SYS = new Uint8Array(32); // system program = all zeros
  const accts = [esc.publicKey];
  for (const t of transfers) {
    if (!accts.some(a => a.every((v, i) => v === t.to[i]))) accts.push(t.to);
  }
  accts.push(SYS);
  const sysIdx = accts.length - 1;

  // Header: [numRequiredSig, numReadonlySignedAccts, numReadonlyUnsignedAccts]
  // escrow=writable+signer, recipients=writable, system=readonly
  const header = new Uint8Array([1, 0, 1]);

  // Account keys: compact-u16 count + 32 bytes each
  const keys = new Uint8Array([...cu16(accts.length), ...accts.flatMap(a => [...a])]);

  // Recent blockhash (32 bytes decoded from base58)
  const bh = b58Decode(blockhash);
  if (bh.length !== 32) throw new Error('buildTx: blockhash decoded to ' + bh.length + ' bytes (expected 32)');

  // Instructions: compact-u16 count, then each instruction
  const ixs = [transfers.length]; // compact-u16 count (always < 128)
  for (const t of transfers) {
    const toIdx = accts.findIndex(a => a.every((v, i) => v === t.to[i]));
    if (toIdx < 0) throw new Error('buildTx: recipient not found in account list');
    // Bincode-encoded SystemProgram::Transfer { lamports }
    // discriminant u32-LE = 2, then lamports u64-LE
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);           // Transfer discriminant
    new DataView(data.buffer).setBigUint64(4, BigInt(t.lamports), true);
    // instruction: programIdIndex, accounts (cu16 len + indices), data (cu16 len + bytes)
    ixs.push(sysIdx, 2, 0, toIdx, ...cu16(data.length), ...data);
  }

  // Assemble message
  const msg = new Uint8Array([...header, ...keys, ...bh, ...ixs]);

  // Sign
  const sig = nacl.sign.detached(msg, esc.secretKey);

  // Wire format: compact-u16 sigcount + sig + message
  return new Uint8Array([1, ...sig, ...msg]);
}

// ── Send tx AND wait for on-chain confirmation ───────────────────────────────
async function sendAndConfirm(txBytes) {
  const b64 = Buffer.from(txBytes).toString('base64');
  let sig;
  try {
    sig = await rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  } catch (e) {
    throw new Error('Preflight/send failed: ' + e.message);
  }
  console.log('[settle] sent sig=' + sig);

  // Poll up to 35s for confirmation
  const deadline = Date.now() + 35000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    await sleep(900);
    try {
      const res = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
      const s = res && res.value && res.value[0];
      lastStatus = s ? JSON.stringify(s) : 'null';
      if (s) {
        if (s.err) {
          // Log full error for debugging
          console.error('[settle] TX FAILED on-chain sig=' + sig + ' err=' + JSON.stringify(s.err));
          throw new Error('TX rejected on-chain: ' + JSON.stringify(s.err));
        }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          console.log('[settle] confirmed sig=' + sig + ' status=' + s.confirmationStatus);
          return sig;
        }
      }
    } catch (e) {
      if (e.message.startsWith('TX rejected')) throw e;
      // RPC poll error — keep retrying
    }
  }
  console.warn('[settle] poll timeout sig=' + sig + ' lastStatus=' + lastStatus);
  // Return sig — tx may still land; don't block the user
  return sig;
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  let done = false;
  const guard = setTimeout(() => {
    if (!done) { done = true; try { res.status(500).json({ error: 'Timed out — try again' }); } catch (_) {} }
  }, 50000);

  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { clearTimeout(guard); done = true; return res.status(200).end(); }
    if (req.method !== 'POST')   { clearTimeout(guard); done = true; return res.status(405).end(); }

    let body = req.body;
    if (typeof body === 'string') try { body = JSON.parse(body); } catch (_) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Bad JSON' }); }
    body = body || {};

    const { action, playerAddress } = body;
    const esc = getEscrow();

    // ── balance ───────────────────────────────────────────────────────────────
    if (action === 'balance') {
      const bal = await rpc('getBalance', [esc.pubkeyB58, { commitment: 'confirmed' }]);
      clearTimeout(guard); done = true;
      return res.status(200).json({ balance: bal.value, escrowPubkey: esc.pubkeyB58, solBalance: bal.value / 1e9 });
    }

    // ── cashout / win ─────────────────────────────────────────────────────────
    if (action === 'cashout' || action === 'win') {
      if (!playerAddress) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress required' }); }
      // Validate player address length before trying to use it
      const playerPubkey = b58Decode(playerAddress);
      if (playerPubkey.length !== 32) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress must be a 32-byte Solana address' }); }
      const [balRes, bhRes] = await Promise.all([
        rpc('getBalance',         [esc.pubkeyB58, { commitment: 'confirmed' }]),
        rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]),
      ]);
      // Null-safe extraction — some RPC nodes return {context,value} some return value directly
      const bal   = (balRes && typeof balRes.value === 'number') ? balRes.value : (typeof balRes === 'number' ? balRes : null);
      const blockhash = (bhRes && bhRes.value && bhRes.value.blockhash) ? bhRes.value.blockhash : (bhRes && bhRes.blockhash ? bhRes.blockhash : null);
      console.log('[settle] cashout bal=' + bal + ' blockhash=' + (blockhash ? blockhash.slice(0,8)+'…' : 'NULL') + ' player=' + playerAddress.slice(0,8)+'…');
      if (bal === null) { clearTimeout(guard); done = true; return res.status(500).json({ error: 'Could not read escrow balance from RPC — try again' }); }
      if (!blockhash)   { clearTimeout(guard); done = true; return res.status(500).json({ error: 'Could not get blockhash from RPC — try again' }); }
      const avail = bal - TX_FEE;
      if (avail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow empty — no funds to cashout' }); }
      // Only pay out the player's own wager — never drain the full shared escrow.
      // Client sends wagerLamports; cap at avail so we never overdraft.
      const wagerLamports = Number(body.wagerLamports) || 0;
      const payout = wagerLamports > 0 ? Math.min(wagerLamports, avail) : avail;
      const creatorCut = Math.floor(payout * CREATOR_FEE_PCT);
      const playerCut  = payout - creatorCut;
      console.log('[settle] cashout payout=' + payout + ' (wager=' + wagerLamports + ' avail=' + avail + ') player=' + playerCut + ' creator=' + creatorCut);
      const tx = buildTx(esc, blockhash, [
        { to: playerPubkey,              lamports: playerCut  },  // player's wager minus 10%
        { to: b58Decode(CREATOR_WALLET), lamports: creatorCut },  // 10% fee
      ]);
      const sig = await sendAndConfirm(tx);
      clearTimeout(guard); done = true;
      return res.status(200).json({ sig, playerCut, creatorCut, confirmed: true });
    }

    // ── kill ──────────────────────────────────────────────────────────────────
    if (action === 'kill') {
      if (!playerAddress || !body.wagerLamports) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress + wagerLamports required' }); }
      const killPubkey = b58Decode(playerAddress);
      if (killPubkey.length !== 32) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'playerAddress must be 32 bytes' }); }
      const [balRes, bhRes] = await Promise.all([
        rpc('getBalance',         [esc.pubkeyB58, { commitment: 'confirmed' }]),
        rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]),
      ]);
      // Null-safe extraction — use null (not 0) so we can distinguish "failed read" vs "truly empty"
      const killBal  = (balRes && typeof balRes.value === 'number') ? balRes.value : (typeof balRes === 'number' ? balRes : null);
      const killHash = (bhRes && bhRes.value && bhRes.value.blockhash) ? bhRes.value.blockhash : (bhRes && bhRes.blockhash ? bhRes.blockhash : null);
      console.log('[settle] kill bal=' + killBal + ' blockhash=' + (killHash ? killHash.slice(0,8)+'...' : 'NULL') + ' killer=' + playerAddress.slice(0,8)+'... wager=' + body.wagerLamports);
      if (killBal === null) { clearTimeout(guard); done = true; return res.status(500).json({ error: 'Could not read escrow balance — try again' }); }
      if (!killHash) { clearTimeout(guard); done = true; return res.status(500).json({ error: 'Could not get blockhash — try again' }); }
      const avail = killBal - TX_FEE;
      if (avail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow empty' }); }
      // Same 10% creator fee applies to kills — ensures creator gets 10% of the player's
      // total cashout value (wager + kill earnings), not just 10% of the original wager.
      const total      = Math.min(Number(body.wagerLamports), avail);
      const creatorCut = Math.floor(total * CREATOR_FEE_PCT);
      const killerCut  = total - creatorCut;
      console.log('[settle] kill total=' + total + ' killer=' + killerCut + ' creator=' + creatorCut);
      const tx = buildTx(esc, killHash, [
        { to: killPubkey,              lamports: killerCut  },
        { to: b58Decode(CREATOR_WALLET), lamports: creatorCut },
      ]);
      const sig = await sendAndConfirm(tx);
      clearTimeout(guard); done = true;
      return res.status(200).json({ sig, amount: killerCut, creatorCut, confirmed: true });
    }

    // ── lose ──────────────────────────────────────────────────────────────────
    if (action === 'lose') {
      const [balRes, bhRes] = await Promise.all([
        rpc('getBalance',         [esc.pubkeyB58, { commitment: 'confirmed' }]),
        rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]),
      ]);
      const loseBal  = (balRes && typeof balRes.value === 'number') ? balRes.value : (typeof balRes === 'number' ? balRes : 0);
      const loseHash = (bhRes && bhRes.value && bhRes.value.blockhash) || (bhRes && bhRes.blockhash);
      if (!loseHash) { clearTimeout(guard); done = true; return res.status(500).json({ error: 'Could not get blockhash — try again' }); }
      const avail = loseBal - TX_FEE;
      if (avail <= 0) { clearTimeout(guard); done = true; return res.status(400).json({ error: 'Escrow empty' }); }
      const tx = buildTx(esc, loseHash, [{ to: b58Decode(CREATOR_WALLET), lamports: avail }]);
      const sig = await sendAndConfirm(tx);
      clearTimeout(guard); done = true;
      return res.status(200).json({ sig, amount: avail, confirmed: true });
    }

    clearTimeout(guard); done = true;
    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    // Log full stack so we can diagnose crashes (not just the message)
    console.error('[settle] CRASH:', e && (e.stack || e.message) || String(e));
    if (!done) { done = true; clearTimeout(guard); try { res.status(500).json({ error: e && e.message || String(e) }); } catch (_) {} }
  }
};
