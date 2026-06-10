'use strict';
// Returns whether a wallet address has an active server-recorded wager.
// Used by the game host to reject players who joined without paying.
const { kvGet } = require('../lib/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const address = (req.query.address || '').trim();
  if (!address) return res.status(400).json({ error: 'address required' });

  const wager = Number(await kvGet('pw:' + address)) || 0;
  return res.status(200).json({ hasWager: wager > 0, wager });
};
