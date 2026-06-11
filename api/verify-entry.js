'use strict';
// Verifies a signed entry token issued by join.js (HMAC mode),
// OR checks whether a wallet has an active wager in KV (wager mode).
//
// HMAC mode (default): GET /api/verify-entry?address=X&lobby=Y&token=Z
//   Token = HMAC(SETTLE_SECRET, "entry:{address}:{lobby}:{10-min-window}") — can't be forged.
//   Used by the host to verify 'hello' messages from joining players.
//
// Wager mode: GET /api/verify-entry?address=X&check=wager
//   Checks that pw:{address} exists in KV (i.e., player paid via join.js and hasn't cashed out).
//   Used by the host to verify 'rejoin' events before re-admitting a player.
const crypto = require('crypto');
const { kvGet } = require('../lib/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { address, lobby, token, check } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });

  // ── Wager mode: KV existence check ────────────────────────────────────────
  if (check === 'wager') {
    try {
      const wager = await kvGet('pw:' + address);
      const valid = wager !== null && Number(wager) > 0;
      return res.status(200).json({ valid });
    } catch (_) {
      // Fail safe: deny rather than accidentally admitting a non-payer
      return res.status(200).json({ valid: false });
    }
  }

  // ── HMAC mode: entry token verification ───────────────────────────────────
  if (!lobby || !token) return res.status(400).json({ error: 'address, lobby, token required' });

  const secret = process.env.SETTLE_SECRET || '';
  if (!secret) return res.status(200).json({ valid: true }); // graceful: if no secret, don't block

  const now = Math.floor(Date.now() / 600_000);
  // Accept current and previous window to handle boundary edge cases
  for (let delta = 0; delta <= 1; delta++) {
    const expected = crypto.createHmac('sha256', secret)
      .update('entry:' + address + ':' + lobby + ':' + (now - delta))
      .digest('hex').slice(0, 32);
    if (expected === token) return res.status(200).json({ valid: true });
  }
  return res.status(200).json({ valid: false });
};
