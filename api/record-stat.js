'use strict';
// api/record-stat.js — POST: update player stats after join or cashout.
// Low-security: no wallet sig required. Earnings come from settle.js (on-chain),
// so the worst a cheater can do is report a fake name.
const { kvGet, kvSetPerm, kvZadd } = require('../lib/kv');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { address, name, earnedLamports, wageredLamports, kills, action } = req.body || {};

    if (!address) return res.status(200).json({ ok: false, error: 'address required' });

    // ── Fetch existing player stats ────────────────────────────────────────────
    const DEFAULT = { name: '', earned: 0, wagered: 0, games: 0, kills: 0 };
    let stats = { ...DEFAULT };
    try {
      const raw = await kvGet('plb:' + address);
      if (raw) stats = { ...DEFAULT, ...JSON.parse(raw) };
    } catch (_) {}

    // Always update name if provided
    if (name) stats.name = String(name).slice(0, 32);

    // ── Apply action ───────────────────────────────────────────────────────────
    if (action === 'join') {
      stats.wagered += Number(wageredLamports) || 0;
      stats.games   += 1;
    } else if (action === 'cashout') {
      stats.earned += Number(earnedLamports) || 0;
      stats.kills  += Number(kills) || 0;
    }

    // ── Persist player stats ───────────────────────────────────────────────────
    await kvSetPerm('plb:' + address, JSON.stringify(stats));

    // ── Update sorted leaderboard set ─────────────────────────────────────────
    await kvZadd('lb:earned', stats.earned, address);

    // ── Update global stats ────────────────────────────────────────────────────
    const GLOBAL_DEFAULT = { totalEarned: 0, totalWagered: 0, gamesPlayed: 0 };
    let global = { ...GLOBAL_DEFAULT };
    try {
      const gRaw = await kvGet('plb:global');
      if (gRaw) global = { ...GLOBAL_DEFAULT, ...JSON.parse(gRaw) };
    } catch (_) {}

    if (action === 'join') {
      global.wagered    = (global.wagered    || 0) + (Number(wageredLamports) || 0);
      global.totalWagered = (global.totalWagered || 0) + (Number(wageredLamports) || 0);
      global.gamesPlayed  = (global.gamesPlayed  || 0) + 1;
    } else if (action === 'cashout') {
      global.totalEarned = (global.totalEarned || 0) + (Number(earnedLamports) || 0);
    }

    await kvSetPerm('plb:global', JSON.stringify(global));

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[record-stat]', err);
    // Never throw — return 200 with error in body so clients don't crash
    return res.status(200).json({ ok: false, error: 'internal error' });
  }
};
