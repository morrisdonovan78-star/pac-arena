// api/privy.js — Server-side proxy for Privy auth API
// Routes browser requests through Vercel so Privy never sees the
// browser's Origin header — eliminates the 403 Invalid-origin error.

const PRIVY_APP_ID = 'cmq1eo6uz004b0cl8pvk7aakk';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const path = (req.query && req.query.path) || '';
  if (!path) { res.status(400).json({ error: 'path query param required' }); return; }

  const target = 'https://auth.privy.io/api/v1' + path;

  const headers = {
    'Content-Type':  'application/json',
    'privy-app-id':  PRIVY_APP_ID,
    'privy-client':  'react-auth:1.92.3',
    'origin':        'https://pac-arena.vercel.app',
  };
  if (req.headers['authorization']) {
    headers['Authorization'] = req.headers['authorization'];
  }

  try {
    const r = await fetch(target, {
      method:  req.method === 'GET' ? 'GET' : 'POST',
      headers,
      body:    req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
      signal:  AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[privy proxy]', e.message);
    res.status(502).json({ error: e.message });
  }
};
