// Vercel serverless — proxies ALL Solana JSON-RPC calls server-side.
// Fixes 403/CORS blocks that happen when browsers hit Solana RPCs directly.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { res.status(405).end(); return; }

  // Ankr now requires a paid API key — removed.
  // api.mainnet-beta.solana.com works fine from Vercel (server-to-server).
  const rpcs = [
    'https://api.mainnet-beta.solana.com',
    'https://solana.public-rpc.com',
    'https://solana-mainnet.g.alchemy.com/v2/demo',
    'https://api.mainnet-beta.solana.com', // retry official once more
  ];

  // RPC error codes that mean "this node can't help us" — try the next one.
  // Legitimate errors (insufficient funds, bad tx, etc.) are passed straight through.
  const INFRA_CODES = new Set([-32052, -32055, -32029, -32603, 403, 429]);

  const body = JSON.stringify(req.body);
  let lastError = 'no endpoints tried';

  for (const rpc of rpcs) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20000),
      });

      // Non-2xx HTTP → this node blocked us, try the next one
      if (!r.ok) {
        lastError = `HTTP ${r.status} from ${rpc}`;
        continue;
      }

      const data = await r.json();

      // RPC returned an infrastructure/auth error → try next endpoint
      if (data.error && INFRA_CODES.has(data.error.code)) {
        lastError = data.error.message || `RPC error ${data.error.code}`;
        continue;
      }

      // Either success (data.result) or a real RPC error (bad tx, etc.) — return it
      res.status(200).json(data);
      return;

    } catch (e) {
      lastError = e.message;
      console.error('[rpc proxy]', rpc, '→', e.message);
    }
  }

  res.status(502).json({
    jsonrpc: '2.0',
    error: { code: -32603, message: 'All RPC endpoints failed: ' + lastError },
    id: null,
  });
};
