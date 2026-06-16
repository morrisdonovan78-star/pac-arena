// api/ably-token.js — Issues short-lived Ably tokens to clients.
// ABLY_KEY env var must be set in Vercel: Settings → Environment Variables
const { kvGet } = require('../lib/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ablyKey = (process.env.ABLY_KEY || '').trim();

  if (!ablyKey) {
    console.error('[ably-token] ABLY_KEY env var is missing or empty');
    res.status(500).json({ error: 'ABLY_KEY env var not set — add it in Vercel dashboard' });
    return;
  }

  const colonIdx = ablyKey.indexOf(':');
  if (colonIdx === -1) {
    console.error('[ably-token] ABLY_KEY format wrong — no colon found. Value starts with:', ablyKey.slice(0, 15));
    res.status(500).json({ error: 'ABLY_KEY format invalid — should be keyName:keySecret' });
    return;
  }

  const keyName = ablyKey.slice(0, colonIdx);
  const auth    = Buffer.from(ablyKey).toString('base64');

  const clientId = (req.query && req.query.clientId)
    || (req.body  && req.body.clientId)
    || undefined;

  // Voice ban check — if wallet is voice-banned, refuse token
  if (clientId) {
    try {
      const raw = await kvGet('voiceban:' + clientId);
      if (raw) {
        const ban = JSON.parse(raw);
        const active = ban.type === 'perm' || (ban.until > 0 && Date.now() < ban.until);
        if (active) {
          const until = ban.type === 'perm' ? 'permanently' : ('until ' + new Date(ban.until).toUTCString());
          console.log('[ably-token] Voice-banned wallet attempted token:', clientId);
          return res.status(403).json({ error: 'Voice chat banned ' + until + (ban.reason ? ': ' + ban.reason : '') });
        }
      }
    } catch (_) {}
  }

  // keyName + timestamp + nonce + capability all required by Ably REST API
  const tokenParams = {
    keyName:    keyName,
    ttl:        3600000,
    timestamp:  Date.now(),
    nonce:      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    // Free-lobby only — paid lobbies require a token issued by join.js after deposit verification.
    // Without a verified deposit, players literally cannot enter presence on paid channels.
    capability: '{"pac-arena-free-lobby":["publish","subscribe","presence","history"]}',
  };
  if (clientId) tokenParams.clientId = clientId;

  console.log('[ably-token] keyName:', keyName, '| clientId:', clientId || '(none)');

  try {
    const r = await fetch(`https://rest.ably.io/keys/${keyName}/requestToken`, {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(tokenParams),
    });

    const body = await r.text();
    console.log('[ably-token] Ably response', r.status, ':', body.slice(0, 200));

    if (!r.ok) {
      res.status(502).json({ error: 'Ably ' + r.status + ': ' + body });
      return;
    }

    res.status(200).setHeader('Content-Type', 'application/json').end(body);

  } catch (e) {
    console.error('[ably-token] fetch failed:', e.message);
    res.status(502).json({ error: e.message });
  }
};
