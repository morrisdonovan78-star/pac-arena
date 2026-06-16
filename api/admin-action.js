'use strict';
// api/admin-action.js — All mod panel actions (requires valid admin token)
// Every request must include header: x-admin-token: <token from admin-auth>
// Actions: status, kick, warn, endgame, ban, unban, voiceban, unvoiceban,
//          checkban, getplayer, getbans, getvoicebans, getlogs
const crypto = require('crypto');
const { kvGet, kvSet, kvSetPerm, kvDel, kvHgetall,
        kvZadd, kvZrevrange, kvZrem,
        kvLpush, kvLtrim, kvLrange } = require('../lib/kv');

// ── Token verification ────────────────────────────────────────────────────────
function verifyToken(token) {
  const secret = (process.env.ADMIN_SECRET || '').trim();
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  try {
    const expected = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
    const sBuf = Buffer.from(sig.padEnd(64, '0'), 'hex');
    const eBuf = Buffer.from(expected, 'hex');
    if (sBuf.length !== eBuf.length || !crypto.timingSafeEqual(sBuf, eBuf)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (payload.sub !== 'mod') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) { return null; }
}

// ── Game server calls ─────────────────────────────────────────────────────────
const SERVERS = [
  process.env.GAME_SERVER_URL    || 'https://pac-arena.duckdns.org',
  process.env.GAME_SERVER_EU_URL || '',
].filter(Boolean);

async function callServer(url, method, body) {
  const secret = (process.env.ADMIN_SECRET || '').trim();
  try {
    const r = await fetch(url + '/admin' + (method === 'GET' ? '/status' : ''), {
      method,
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { error: 'Server returned ' + r.status };
    return await r.json();
  } catch (e) { return { error: e.message, offline: true }; }
}

async function callAllServers(path, method, body) {
  const secret = (process.env.ADMIN_SECRET || '').trim();
  return Promise.all(SERVERS.map(async url => {
    try {
      const r = await fetch(url + '/admin/' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return { server: url, error: 'HTTP ' + r.status };
      return { server: url, ...(await r.json()) };
    } catch (e) { return { server: url, error: e.message, offline: true }; }
  }));
}

// ── Mod action log ────────────────────────────────────────────────────────────
async function logAction(action, target, detail) {
  try {
    const entry = JSON.stringify({ ts: Date.now(), action, target: target || '', detail: detail || '' });
    await kvLpush('admin:log', entry);
    await kvLtrim('admin:log', 0, 199); // keep last 200 entries
  } catch (_) {}
}

// ── Ban helpers ───────────────────────────────────────────────────────────────
const DURATIONS = { '1h': 3600, '3h': 10800, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000, 'perm': 0 };

function parseDuration(d) { return DURATIONS[d] ?? 3600; }

async function writeBan(listKey, recordKey, address, durationKey, reason) {
  const ttlSec = parseDuration(durationKey);
  const until  = durationKey === 'perm' ? 0 : Date.now() + ttlSec * 1000;
  const rec    = JSON.stringify({ type: durationKey === 'perm' ? 'perm' : 'temp', until, reason: reason || '', at: Date.now() });
  if (durationKey === 'perm') {
    await kvSetPerm(recordKey, rec);
  } else {
    await kvSet(recordKey, rec, ttlSec);
  }
  // Maintain sorted set (score = ban timestamp) for listing
  await kvZadd(listKey, Date.now(), address);
}

async function removeBan(listKey, recordKey, address) {
  await kvDel(recordKey);
  await kvZrem(listKey, address);
}

function parseBanRecord(raw) {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    if (b.type === 'temp' && b.until > 0 && Date.now() > b.until) return null;
    return b;
  } catch (_) { return null; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Robots-Tag', 'noindex,nofollow');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers['x-admin-token'] || '').trim();
  if (!verifyToken(token)) {
    return res.status(403).json({ error: 'Invalid or expired session. Log in again.' });
  }

  const { action, address, reason, duration, message, lobbyId } = req.body || {};

  // ── status: live game server view ────────────────────────────────────────────
  if (action === 'status') {
    const results = await callAllServers('status', 'GET');
    return res.json({ servers: results });
  }

  // ── kick: remove player from active game ─────────────────────────────────────
  if (action === 'kick') {
    if (!address) return res.status(400).json({ error: 'address required' });
    const results = await callAllServers('kick', 'POST', { walletAddress: address, reason });
    await logAction('kick', address, reason);
    return res.json({ ok: true, results });
  }

  // ── warn: on-screen warning message ──────────────────────────────────────────
  if (action === 'warn') {
    if (!address || !message) return res.status(400).json({ error: 'address and message required' });
    const results = await callAllServers('warn', 'POST', { walletAddress: address, message });
    await logAction('warn', address, message);
    return res.json({ ok: true, results });
  }

  // ── endgame: force-end an active match ───────────────────────────────────────
  if (action === 'endgame') {
    if (!lobbyId) return res.status(400).json({ error: 'lobbyId required' });
    const results = await callAllServers('endgame', 'POST', { lobbyId, reason });
    await logAction('endgame', lobbyId, reason);
    return res.json({ ok: true, results });
  }

  // ── ban: block from all game lobbies ─────────────────────────────────────────
  if (action === 'ban') {
    if (!address || !duration) return res.status(400).json({ error: 'address and duration required' });
    await writeBan('admin:banlist', 'ban:' + address, address, duration, reason);
    // Also kick immediately
    await callAllServers('kick', 'POST', { walletAddress: address, reason: 'Banned: ' + (reason || 'rule violation') });
    await logAction('ban:' + duration, address, reason);
    return res.json({ ok: true });
  }

  // ── unban ─────────────────────────────────────────────────────────────────────
  if (action === 'unban') {
    if (!address) return res.status(400).json({ error: 'address required' });
    await removeBan('admin:banlist', 'ban:' + address, address);
    await logAction('unban', address, reason);
    return res.json({ ok: true });
  }

  // ── voiceban: block from voice chat ──────────────────────────────────────────
  if (action === 'voiceban') {
    if (!address || !duration) return res.status(400).json({ error: 'address and duration required' });
    await writeBan('admin:vbanlist', 'voiceban:' + address, address, duration, reason);
    await logAction('voiceban:' + duration, address, reason);
    return res.json({ ok: true });
  }

  // ── unvoiceban ────────────────────────────────────────────────────────────────
  if (action === 'unvoiceban') {
    if (!address) return res.status(400).json({ error: 'address required' });
    await removeBan('admin:vbanlist', 'voiceban:' + address, address);
    await logAction('unvoiceban', address, reason);
    return res.json({ ok: true });
  }

  // ── checkban: combined ban status for one address ─────────────────────────────
  if (action === 'checkban') {
    if (!address) return res.status(400).json({ error: 'address required' });
    const [gameBanRaw, voiceBanRaw, playerHash] = await Promise.all([
      kvGet('ban:'      + address),
      kvGet('voiceban:' + address),
      kvHgetall('ph:'   + address),
    ]);
    return res.json({
      gameBan:   parseBanRecord(gameBanRaw),
      voiceBan:  parseBanRecord(voiceBanRaw),
      player:    playerHash,
    });
  }

  // ── getplayer: stats + ban status ─────────────────────────────────────────────
  if (action === 'getplayer') {
    if (!address) return res.status(400).json({ error: 'address required' });
    const [h, gameBanRaw, voiceBanRaw] = await Promise.all([
      kvHgetall('ph:' + address),
      kvGet('ban:'      + address),
      kvGet('voiceban:' + address),
    ]);
    return res.json({
      player:   h,
      gameBan:  parseBanRecord(gameBanRaw),
      voiceBan: parseBanRecord(voiceBanRaw),
    });
  }

  // ── getbans: list active game bans ────────────────────────────────────────────
  if (action === 'getbans' || action === 'getvoicebans') {
    const listKey = action === 'getbans' ? 'admin:banlist' : 'admin:vbanlist';
    const recPfx  = action === 'getbans' ? 'ban:'          : 'voiceban:';
    try {
      // ZREVRANGE with WITHSCORES gives alternating [member, score, ...]
      const raw = await kvZrevrange(listKey, 0, 99);
      if (!Array.isArray(raw) || raw.length === 0) return res.json({ bans: [] });
      const addresses = [];
      for (let i = 0; i < raw.length; i += 2) addresses.push(raw[i]);
      const records = await Promise.all(addresses.map(a => kvGet(recPfx + a)));
      const bans = addresses.map((a, i) => {
        const rec = parseBanRecord(records[i]);
        if (!rec) return null;
        return { address: a, ...rec };
      }).filter(Boolean);
      return res.json({ bans });
    } catch (e) { return res.json({ bans: [], error: e.message }); }
  }

  // ── getlogs: recent mod actions ───────────────────────────────────────────────
  if (action === 'getlogs') {
    try {
      const raw = await kvLrange('admin:log', 0, 99);
      const logs = (raw || []).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
      return res.json({ logs });
    } catch (e) { return res.json({ logs: [], error: e.message }); }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
