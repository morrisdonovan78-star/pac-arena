'use strict';
// api/leaderboard.js — GET top-20 players; POST to register/update display name
const { kvGet, kvSetPerm, kvDel, kvZadd, kvZrevrange,
        kvHincrby, kvHget, kvHset, kvHsetnx, kvHgetall } = require('../lib/kv');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Read player stats from the new ph: hash key, with fallback to old plb: JSON blob.
// Migrates old data on first read so future writes stay on hash keys only.
async function readStats(address) {
  const empty = { name:'', earned:0, wagered:0, games:0, kills:0, wins:0, losses:0 };

  // Try new hash key first
  const h = await kvHgetall('ph:' + address);
  if (h && Object.keys(h).length > 0) {
    const stats = {
      name:    h.name   || '',
      earned:  parseInt(h.earned)  || 0,
      wagered: parseInt(h.wagered) || 0,
      games:   parseInt(h.games)   || 0,
      kills:   parseInt(h.kills)   || 0,
      wins:    parseInt(h.wins)    || 0,
      losses:  parseInt(h.losses)  || 0,
    };
    // Hash exists but may be missing name if player played after hash migration but before
    // explicitly setting a name. Check old JSON blob for the name and migrate it.
    if (!stats.name) {
      try {
        const raw = await kvGet('plb:' + address);
        if (raw) {
          const old = JSON.parse(raw);
          if (old.name) {
            stats.name = old.name;
            await kvHset('ph:' + address, 'name', old.name);
          }
        }
      } catch(_) {}
    }
    return stats;
  }

  // Fall back to old JSON blob (plb: key) and migrate into hash
  const raw = await kvGet('plb:' + address);
  if (!raw) return empty;
  try {
    const s = { ...empty, ...JSON.parse(raw) };
    // Migrate: write each field into the hash atomically (HINCRBY for ints, HSET for name)
    if (s.name)    await kvHset('ph:' + address, 'name',    s.name);
    if (s.earned)  await kvHincrby('ph:' + address, 'earned',  s.earned);
    if (s.wagered) await kvHincrby('ph:' + address, 'wagered', s.wagered);
    if (s.games)   await kvHincrby('ph:' + address, 'games',   s.games);
    if (s.kills)   await kvHincrby('ph:' + address, 'kills',   s.kills);
    if (s.wins)    await kvHincrby('ph:' + address, 'wins',    s.wins);
    if (s.losses)  await kvHincrby('ph:' + address, 'losses',  s.losses);
    return s;
  } catch (_) { return empty; }
}

// Read global counters from new hash, with fallback to old JSON blob.
async function readGlobal() {
  const empty = { totalEarned:0, totalWagered:0, gamesPlayed:0 };
  const h = await kvHgetall('ph:global');
  if (h && Object.keys(h).length > 0) {
    return {
      totalEarned:  parseInt(h.totalEarned)  || 0,
      totalWagered: parseInt(h.totalWagered) || 0,
      gamesPlayed:  parseInt(h.gamesPlayed)  || 0,
    };
  }
  // Fallback to old plb:global JSON
  const raw = await kvGet('plb:global');
  if (!raw) return empty;
  try {
    const g = { ...empty, ...JSON.parse(raw) };
    // Migrate
    if (g.totalEarned)  await kvHincrby('ph:global', 'totalEarned',  g.totalEarned);
    if (g.totalWagered) await kvHincrby('ph:global', 'totalWagered', g.totalWagered);
    if (g.gamesPlayed)  await kvHincrby('ph:global', 'gamesPlayed',  g.gamesPlayed);
    return g;
  } catch (_) { return empty; }
}

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
      const oldName = await kvHget('ph:' + address, 'name')
                   || (() => { try { return JSON.parse('').name; } catch(_){} return ''; })();
      // Also check old JSON blob for name if hash is empty
      if (!oldName) {
        try {
          const raw = await kvGet('plb:' + address);
          if (raw) {
            const s = JSON.parse(raw);
            if (s.name && s.name !== clean) {
              await kvDel('nameReg:' + s.name.toUpperCase()).catch(()=>{});
            }
          }
        } catch(_) {}
      } else if (oldName !== clean) {
        await kvDel('nameReg:' + oldName.toUpperCase()).catch(()=>{});
      }

      // Register new name and persist to player hash
      await kvSetPerm('nameReg:' + clean, address);
      await kvHset('ph:' + address, 'name', clean);

      // Ensure player is in the sorted set (so they appear in leaderboard)
      const earned = await kvHget('ph:' + address, 'earned');
      await kvZadd('lb:earned', Number(earned) || 0, address);

      return res.status(200).json({ ok: true, name: clean });
    } catch (err) {
      console.error('[leaderboard/setname]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── GET ?address= — single player profile ───────────────────────────────────
  if (req.query && req.query.address) {
    try {
      const addr = String(req.query.address).trim();
      const stats = await readStats(addr);
      const hasData = stats.earned > 0 || stats.wagered > 0 || stats.games > 0 || stats.name;
      if (!hasData) return res.status(200).json({ player: null });
      return res.status(200).json({ player: { address: addr, ...stats } });
    } catch (err) {
      console.error('[leaderboard/player]', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ── GET — top-20 leaderboard ────────────────────────────────────────────────
  try {
    const raw = await kvZrevrange('lb:earned', 0, 19) || [];

    const pairs = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({ address: raw[i], score: raw[i + 1] });
    }

    const [playerResults, global] = await Promise.all([
      Promise.all(pairs.map(({ address }) => readStats(address))),
      readGlobal(),
    ]);

    const players = pairs.map(({ address }, idx) => {
      const stats = playerResults[idx];
      return {
        rank:    idx + 1,
        address,
        name:    stats.name    || '',
        earned:  stats.earned  || 0,
        wagered: stats.wagered || 0,
        games:   stats.games   || 0,
        kills:   stats.kills   || 0,
        wins:    stats.wins    || 0,
        losses:  stats.losses  || 0,
      };
    });

    return res.status(200).json({ players, global });
  } catch (err) {
    console.error('[leaderboard]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
