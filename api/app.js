'use strict';
const fs   = require('fs');
const path = require('path');

let _cached = null;

module.exports = function handler(req, res) {
  // ── Cache-bust redirect ──────────────────────────────────────────────────────
  // The problem: browsers may have the old HTML cached from before we started
  // serving via this function.  A cached response is served without hitting the
  // server at all, so no amount of server-side headers can evict it.
  //
  // Solution: every unversioned URL (/, /pac-arena.html, etc.) is redirected to
  // /?_v=<current-deployment-id>.  Browsers have never cached that URL, so they
  // MUST make a fresh request and get the latest HTML.  On the next deploy the
  // deployment ID changes → new URL → cache busted again automatically.
  // The redirect itself has no-store so it can never be cached.
  const deployId = process.env.VERCEL_DEPLOYMENT_ID
                || process.env.VERCEL_GIT_COMMIT_SHA
                || 'dev';
  const url = req.url || '/';

  if (!url.includes('_v=')) {
    res.setHeader('Cache-Control',          'no-store');
    res.setHeader('Vercel-CDN-Cache-Control','no-store');
    res.setHeader('CDN-Cache-Control',      'no-store');
    return res.redirect(302, '/?_v=' + encodeURIComponent(deployId));
  }

  // ── Serve HTML ───────────────────────────────────────────────────────────────
  try {
    if (!_cached) {
      _cached = fs.readFileSync(path.resolve('index.html'), 'utf8');
    }
    res.setHeader('Content-Type',           'text/html; charset=utf-8');
    res.setHeader('Cache-Control',          'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Vercel-CDN-Cache-Control','no-store');
    res.setHeader('CDN-Cache-Control',      'no-store');
    res.setHeader('Pragma',                 'no-cache');
    res.setHeader('Expires',               '0');
    res.status(200).send(_cached);
  } catch (e) {
    res.status(500).send('Error loading app: ' + e.message);
  }
};
