'use strict';
// api/check-ban.js — Lightweight ban check called by the game server on each socket connect.
// GET ?address=WALLET — returns { banned: bool, ban? }
// Protected by x-admin-secret header (same ADMIN_SECRET env var used on game server).
const { kvGet } = require('../lib/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const secret    = (process.env.ADMIN_SECRET || '').trim();
  const reqSecret = (req.headers['x-admin-secret'] || req.query.secret || '').trim();
  if (!secret || reqSecret !== secret) return res.status(403).json({ error: 'Forbidden' });

  const address = (req.query.address || '').trim();
  if (!address) return res.status(400).json({ error: 'address required' });

  const raw = await kvGet('ban:' + address);
  if (!raw) return res.json({ banned: false });

  try {
    const ban = JSON.parse(raw);
    if (ban.type === 'temp' && ban.until > 0 && Date.now() > ban.until) {
      return res.json({ banned: false });
    }
    return res.json({ banned: true, ban });
  } catch (_) { return res.json({ banned: false }); }
};
