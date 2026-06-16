// ═══════════════════════════════════════════════════════════════════════════
// SERVER ADMIN PATCH — add this code to /opt/pac-arena/server.js on Vultr
// ═══════════════════════════════════════════════════════════════════════════
//
// SETUP STEPS (run these over SSH once):
//
//   1. SSH in:
//      ssh root@149.28.119.247
//
//   2. Set ADMIN_SECRET env var for PM2 (use the SAME value you set in Vercel):
//      pm2 stop pac-arena
//      export ADMIN_SECRET="your-secret-here"
//      pm2 set pac-arena:ADMIN_SECRET "your-secret-here"
//
//   3. Add the code blocks below into /opt/pac-arena/server.js:
//      - Block A: paste near the top (after requires, before io/app setup)
//      - Block B: paste before the last line (before server.listen or io.listen)
//
//   4. Also add wallet tracking (Block C) to the player join/connection logic
//
//   5. Restart: pm2 restart pac-arena && pm2 save
//
// ═══════════════════════════════════════════════════════════════════════════

// ─── BLOCK A: paste near the top of server.js, after express/io setup ────────

const ADMIN_SECRET_SRV = (process.env.ADMIN_SECRET || '').trim();

function requireAdmin(req, res, next) {
  const s = (req.headers['x-admin-secret'] || req.query.secret || '').trim();
  if (!ADMIN_SECRET_SRV || s !== ADMIN_SECRET_SRV) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ─── BLOCK B: paste before server.listen() ───────────────────────────────────

// Admin: live status of all rooms
app.get('/admin/status', requireAdmin, (req, res) => {
  const LOBBY_IDS = ['free-lobby', 'paid-lobby-1', 'paid-lobby-5', 'paid-lobby-25'];
  const rooms = {};
  for (const lid of LOBBY_IDS) {
    const room = io.sockets.adapter.rooms.get(lid);
    const players = [];
    if (room) {
      for (const socketId of room) {
        const sock = io.sockets.sockets.get(socketId);
        if (sock) {
          players.push({
            socketId,
            walletAddress: sock.walletAddress || null,
            playerName:    sock.playerName    || null,
            joinedAt:      sock.joinedAt      || null,
          });
        }
      }
    }
    rooms[lid] = players;
  }
  res.json({ rooms, timestamp: Date.now() });
});

// Admin: kick a player by wallet address
app.post('/admin/kick', requireAdmin, express.json(), (req, res) => {
  const { walletAddress, reason } = req.body || {};
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });
  let kicked = 0;
  for (const [, sock] of io.sockets.sockets) {
    if (sock.walletAddress === walletAddress) {
      sock.emit('admin-kick', { reason: reason || 'Kicked by moderator' });
      setTimeout(() => { try { sock.disconnect(true); } catch(_) {} }, 600);
      kicked++;
    }
  }
  res.json({ ok: true, kicked });
});

// Admin: send on-screen warning to a player
app.post('/admin/warn', requireAdmin, express.json(), (req, res) => {
  const { walletAddress, message } = req.body || {};
  if (!walletAddress || !message) return res.status(400).json({ error: 'walletAddress and message required' });
  let sent = 0;
  for (const [, sock] of io.sockets.sockets) {
    if (sock.walletAddress === walletAddress) {
      sock.emit('admin-warn', { message });
      sent++;
    }
  }
  res.json({ ok: true, sent });
});

// Admin: force-end an active game in a lobby
app.post('/admin/endgame', requireAdmin, express.json(), (req, res) => {
  const { lobbyId } = req.body || {};
  if (!lobbyId) return res.status(400).json({ error: 'lobbyId required' });
  io.to(lobbyId).emit('admin-endgame', { reason: 'Game ended by moderator' });
  res.json({ ok: true });
});

// ─── BLOCK C: wallet tracking — add inside your socket 'connection' handler ──
//
// Somewhere in your io.on('connection', (socket) => { ... }) block, when the
// player sends their join/auth event (whatever event carries walletAddress),
// add these two lines so the kick endpoint can find the socket:
//
//   socket.walletAddress = data.walletAddress;  // or however your server gets it
//   socket.playerName    = data.playerName || data.name || '';
//   socket.joinedAt      = Date.now();
//
// For the ban check on free-lobby connections, add this near the top of your
// 'connection' handler (before the player joins any room):
//
//   const walletAddr = data.walletAddress || socket.handshake.auth?.walletAddress;
//   if (walletAddr) {
//     try {
//       const checkUrl = 'https://pac-arena.vercel.app/api/admin?do=checkban&address=' + encodeURIComponent(walletAddr);
//       const r = await fetch(checkUrl, { headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
//       const banData = await r.json();
//       if (banData.banned) {
//         socket.emit('admin-kick', { reason: 'You are banned from PAC ARENA.' });
//         setTimeout(() => socket.disconnect(true), 400);
//         return;
//       }
//     } catch (_) {} // never block a player due to KV error
//   }
//
// ═══════════════════════════════════════════════════════════════════════════
// FULL SSH COMMAND SEQUENCE (copy-paste into your terminal):
// ═══════════════════════════════════════════════════════════════════════════
//
//   ssh root@149.28.119.247
//   cd /opt/pac-arena
//   nano server.js          ← make the edits described above
//   pm2 restart pac-arena
//   pm2 save
//
// VERIFY the endpoints work (replace YOUR_SECRET with your actual secret):
//
//   curl -s -H "x-admin-secret: YOUR_SECRET" http://localhost:3001/admin/status | head -c 500
//
// ═══════════════════════════════════════════════════════════════════════════
