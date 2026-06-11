'use strict';
// api/leaderboard.js — GET top-20 players by earned SOL
const { kvZrevrange, kvGet } = require('../lib/kv');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ZREVRANGE returns a flat array: [addr0, score0, addr1, score1, ...]
    const raw = await kvZrevrange('lb:earned', 0, 19) || [];

    // Pair up addresses and scores
    const pairs = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({ address: raw[i], score: raw[i + 1] });
    }

    // Fetch per-player stats in parallel
    const [playerResults, globalRaw] = await Promise.all([
      Promise.all(pairs.map(({ address }) => kvGet('plb:' + address))),
      kvGet('plb:global'),
    ]);

    const players = pairs.map(({ address }, idx) => {
      let stats = { name: '', earned: 0, wagered: 0, games: 0, kills: 0, wins: 0, losses: 0 };
      try {
        if (playerResults[idx]) stats = { ...stats, ...JSON.parse(playerResults[idx]) };
      } catch (_) {}
      return {
        rank: idx + 1,
        address,
        name: stats.name || '',
        earned: stats.earned || 0,
        wagered: stats.wagered || 0,
        games: stats.games || 0,
        kills: stats.kills || 0,
        wins: stats.wins || 0,
        losses: stats.losses || 0,
      };
    });

    let global = { totalEarned: 0, totalWagered: 0, gamesPlayed: 0 };
    try {
      if (globalRaw) global = { ...global, ...JSON.parse(globalRaw) };
    } catch (_) {}

    return res.status(200).json({ players, global });
  } catch (err) {
    console.error('[leaderboard]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
