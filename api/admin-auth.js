'use strict';
// api/admin-auth.js — Password login → signed session token
// POST { password } → { token, ttl }
// Security:
//   - Timing-safe password comparison (prevents timing oracle attacks)
//   - IP-based lockout after 5 wrong attempts (15-minute cooldown)
//   - Token is HMAC-SHA256 signed with ADMIN_SECRET — never leaves server logic
//   - ADMIN_PASSWORD and ADMIN_SECRET are env vars only, never in code
const crypto = require('crypto');
const { kvGet, kvSet, kvDel } = require('../lib/kv');

const TOKEN_TTL_S  = 8 * 3600;  // 8-hour sessions
const MAX_ATTEMPTS = 5;
const LOCKOUT_S    = 900;        // 15 minutes

function makeToken(secret) {
  const payload = {
    sub: 'mod',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  return encoded + '.' + sig;
}

function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip']
    || 'unknown');
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Robots-Tag', 'noindex,nofollow');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const password = (process.env.ADMIN_PASSWORD || '').trim();
  const secret   = (process.env.ADMIN_SECRET   || '').trim();
  if (!password || !secret) {
    console.error('[admin-auth] ADMIN_PASSWORD or ADMIN_SECRET env var not configured');
    return res.status(503).json({ error: 'Admin panel not configured — set env vars' });
  }

  const ip      = clientIp(req);
  const lockKey = 'admin:fail:' + ip;

  // Lockout check
  const attempts = parseInt(await kvGet(lockKey)) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many failed attempts. Wait 15 minutes.' });
  }

  const { password: submitted } = req.body || {};
  if (!submitted || typeof submitted !== 'string') {
    return res.status(400).json({ error: 'Password required' });
  }

  // Timing-safe compare — prevents brute-force timing side-channels
  let match = false;
  try {
    const a = Buffer.from(submitted.trim().padEnd(128));
    const b = Buffer.from(password.padEnd(128));
    match = crypto.timingSafeEqual(a, b) && submitted.trim() === password;
  } catch (_) {}

  if (!match) {
    const next = attempts + 1;
    await kvSet(lockKey, String(next), LOCKOUT_S);
    const left = MAX_ATTEMPTS - next;
    console.warn('[admin-auth] Bad password from', ip, '— attempt', next);
    if (left <= 0) {
      return res.status(429).json({ error: 'Too many failed attempts. Locked out for 15 minutes.' });
    }
    return res.status(401).json({ error: `Wrong password. ${left} attempt${left === 1 ? '' : 's'} remaining.` });
  }

  // Good — clear lockout, issue token
  await kvDel(lockKey).catch(() => {});
  const token = makeToken(secret);
  console.log('[admin-auth] Login success from', ip);
  return res.status(200).json({ token, ttl: TOKEN_TTL_S });
};
