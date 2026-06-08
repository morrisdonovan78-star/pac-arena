// api/price.js — Real-time SOL/USD price with multi-source fallback + server-side caching.
// Clients call GET /api/price instead of hitting CoinGecko directly.
// The server caches the price for 30 seconds so hundreds of concurrent players
// don't each spam external APIs (and hit rate limits).

let _cached = null;   // last known good price
let _cacheTs = 0;     // timestamp of last successful fetch
const CACHE_TTL = 30_000; // 30-second server cache

// Sources tried in order — first success wins.
const SOURCES = [
  {
    name: 'Binance',
    url:  'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    parse: d => parseFloat(d?.price),
  },
  {
    name: 'Coinbase',
    url:  'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    parse: d => parseFloat(d?.data?.amount),
  },
  {
    name: 'Jupiter',
    url:  'https://price.jup.ag/v6/price?ids=SOL',
    parse: d => d?.data?.SOL?.price,
  },
  {
    name: 'CoinGecko',
    url:  'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    parse: d => d?.solana?.usd,
  },
  {
    name: 'CoinPaprika',
    url:  'https://api.coinpaprika.com/v1/tickers/sol-solana',
    parse: d => d?.quotes?.USD?.price,
  },
];

async function trySource(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  try {
    const r = await fetch(src.url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const p = src.parse(d);
    if (!p || isNaN(p) || p <= 0) throw new Error(`bad value: ${p}`);
    return p;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Return cached price if still fresh
  const now = Date.now();
  if (_cached && now - _cacheTs < CACHE_TTL) {
    return res.status(200).json({
      price:  _cached,
      source: 'cache',
      age:    Math.round((now - _cacheTs) / 1000),
    });
  }

  // Try each source in order
  let lastErr;
  for (const src of SOURCES) {
    try {
      const price = await trySource(src);
      _cached  = price;
      _cacheTs = Date.now();
      console.log(`[price] ${src.name} → $${price.toFixed(4)}`);
      return res.status(200).json({ price, source: src.name, age: 0 });
    } catch (e) {
      console.error(`[price] ${src.name} failed: ${e.message}`);
      lastErr = e;
    }
  }

  // All live sources failed — return stale cache rather than breaking the UI
  if (_cached) {
    console.warn('[price] all sources failed — returning stale cache');
    return res.status(200).json({
      price:  _cached,
      source: 'stale',
      age:    Math.round((now - _cacheTs) / 1000),
    });
  }

  res.status(502).json({ error: 'All price sources unavailable: ' + lastErr?.message });
};
