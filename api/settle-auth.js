'use strict';
// Issues short-lived HMAC tokens that settle.js requires on every cashout/kill.
// Token is time-based only (2-min window) — no parameter binding to avoid mismatches.
// SETTLE_SECRET must be set in Vercel env vars — never in code.

const crypto = require('crypto');

function makeToken() {
  const secret = process.env.SETTLE_SECRET || '';
  if (!secret) {
    console.warn('[settle-auth] SETTLE_SECRET not set — token auth disabled');
    return 'open';
  }
  const w = Math.floor(Date.now() / 120_000);
  return crypto.createHmac('sha256', secret).update(String(w)).digest('hex');
}

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    let body = req.body;
    if (typeof body === 'string') try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'Bad JSON' }); }
    body = body || {};
    if (!body.action) return res.status(400).json({ error: 'action required' });
    const token = makeToken();
    return res.status(200).json({ token, expiresIn: 120 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
