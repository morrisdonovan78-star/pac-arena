'use strict';
// Thin wrapper around Vercel KV (Upstash Redis) REST API.
// Requires KV_REST_API_URL + KV_REST_API_TOKEN env vars (set automatically when you
// connect a KV store to this project in the Vercel dashboard → Storage).
// If env vars are missing every function returns null — game degrades gracefully.

async function _cmd(cmd) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify(cmd),
      signal:  AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.result ?? null;
  } catch (_) { return null; }
}

const kvGet = (key)           => _cmd(['GET', key]);
const kvSet = (key, val, ttl) => _cmd(['SET', key, String(val), 'EX', String(ttl)]);
const kvDel = (key)           => _cmd(['DEL', key]);

module.exports = { kvGet, kvSet, kvDel };
