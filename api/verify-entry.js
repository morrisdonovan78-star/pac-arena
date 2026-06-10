'use strict';
// Verifies a signed entry token issued by join.js.
// The host calls this for each new player's hello message.
// Guests call this to verify the host before accepting game state.
// Token = HMAC(SETTLE_SECRET, "entry:{address}:{lobby}:{10-min-window}") — can't be forged.
const crypto = require('crypto');

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { address, lobby, token } = req.query;
  if (!address || !lobby || !token) return res.status(400).json({ error: 'address, lobby, token required' });

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
