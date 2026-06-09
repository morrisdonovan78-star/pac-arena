'use strict';
// Serves index.html through a serverless function instead of as a static file.
// Vercel's CDN never caches function responses, so every player always gets
// the latest HTML on every visit — no browser cache clearing ever needed.
const fs   = require('fs');
const path = require('path');

let _cached = null; // in-process cache: re-read on cold starts only

module.exports = function handler(req, res) {
  try {
    if (!_cached) {
      _cached = fs.readFileSync(path.resolve('index.html'), 'utf8');
    }
    res.setHeader('Content-Type',           'text/html; charset=utf-8');
    // These two headers together prevent both the browser AND Vercel's own CDN edge
    // from caching this response. Setting them here in the function (not just in
    // vercel.json headers config) ensures they apply before the CDN stores the response.
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
