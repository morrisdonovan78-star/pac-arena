'use strict';
// api/leaderboard.js — GET top-20 players; POST to register/update display name
const { kvZrevrange, kvGet, kvSetPerm, kvDel } = require('../lib/kv');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── POST — register or update display name ──────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { action, address, name } = req.body || {};
      if (action !== 'setname' || !address || !name) {
        return res.status(400).json({ error: 'Bad request' });
      }
      const clean = String(name).replace(/[^A-Za-z0-9_\- ]/g, '').trim().slice(0, 14).toUpperCase();
      if (!clean) return res.status(400).json({ error: 'Invalid name' });

      // Check if name is already taken by a different address
      const existingAddr = await kvGet('nameReg:' + clean);
      if (existingAddr && existingAddr !== address) {
        return res.status(200).json({ error: 'taken' });
      }

      // Clear old name registry entry if player is changing names
      const playerRaw = await kvGet('plb:' + address);
      const existing = playerRaw ? { name: '', earned: 0, wagered: 0, games: 0, kills: 0, wins: 0, losses: 0, ...JSON.parse(playerRaw) } : { name: '', earned: 0, wagered: 0, games: 0, kills: 0, wins: 0, losses: 0 };
      if (existing.name && existing.name !== clean) {
        try { await kvDel('nameReg:' + existing.name.toUpperCase()); } catch (_) {}
      }

      // Register new name and persist to player record
      await kvSetPerm('nameReg:' + clean, address);
      existing.name = clean;
      await kvSetPerm('plb:' + address, JSON.stringify(existing));

      return res.status(200).json({ ok: true, name: clean });
    } catch (err) {
      console.error('[leaderboard/setname]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── GET — top-20 leaderboard ────────────────────────────────────────────────
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
