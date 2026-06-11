'use strict';
// Checks whether a wallet has an active wager record in KV.
// Called by the host before re-admitting a player via the 'rejoin' event.
// Only tells the host YES or NO — does not reveal the wager amount.
const { kvGet } = require('../lib/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { address } = req.query;
  if (!address || typeof address !== 'string' || address.length < 32) {
    return res.status(400).json({ error: 'address required' });
  }

  try {
    const wager = await kvGet('pw:' + address);
    const valid = wager !== null && Number(wager) > 0;
    return res.status(200).json({ valid });
  } catch (_) {
    // Fail safe: deny rather than accidentally admitting a non-payer
    return res.status(200).json({ valid: false });
  }
};
