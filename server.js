'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const GAME_SECRET = (process.env.GAME_SECRET || '').trim();
const _usedGameTokens = new Set(); // server-level: survives room deletion, never cleared on disconnect
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ── Game constants ────────────────────────────────────────────────────────────
const C=48,R=36,TICK_MS=33;
const CHERRY_TICKS=300, PEPPER_TICKS=390;
const CHERRY_RESPAWN=300, PEPPER_RESPAWN=240;

// ── Maze ──────────────────────────────────────────────────────────────────────
const MAZE_BASE=[
[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
[1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
[1,1,0,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,0,1,1,1,0,1,1,1,1,1,1,1,0,1,1,1,1,1,1,0,1],
[1,1,0,1,0,0,0,1,0,0,1,0,0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,0,1,1,1,0,1,1,0,0,0,0,1,0,1,1,0,0,1,1,0,1],
[1,1,0,1,0,0,0,1,0,0,1,0,0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,0,1,1,1,0,1,1,0,0,0,0,1,0,1,1,0,0,1,1,0,1],
[1,1,0,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,1,1,1,1,1,1,1,0,1,1,1,1,1,1,0,1],
[1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,1],
[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,1],
[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,1],
[1,1,0,0,0,0,0,0,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,1],
[1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],
[1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,1,1],
[1,1,0,0,0,0,0,0,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,1],
[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,1],
[1,1,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,1],
[1,1,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,1,1,1,1],
[1,1,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,1,1,1,1],
[1,1,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,1],
[1,1,0,1,1,1,0,1,1,1,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,1,1,1,0,1,1,1,1,1,1,0,1],
[1,1,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,1],
[1,1,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,1],
[1,1,0,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,0,0,1,1,1,1,1,1,1,1,0,0,0,1,1,1,1,0,1,1,1,0,1,1,1,1,1,1,0,1],
[1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
];

const SPAWNS=[
  {x:2,y:2},{x:46,y:2},{x:2,y:7},{x:46,y:7},
  {x:2,y:11},{x:46,y:11},{x:9,y:15},{x:27,y:15},
  {x:9,y:20},{x:27,y:20},{x:2,y:24},{x:46,y:24},
  {x:2,y:29},{x:46,y:29},{x:2,y:34},{x:46,y:34}
];

const POW_SPOTS=[
  {x:2,y:2},{x:46,y:2},{x:9,y:2},{x:38,y:2},
  {x:2,y:7},{x:46,y:7},{x:15,y:7},{x:31,y:7},
  {x:2,y:11},{x:9,y:11},{x:46,y:11},
  {x:9,y:15},{x:27,y:15},{x:9,y:20},{x:27,y:20},
  {x:2,y:24},{x:9,y:24},{x:46,y:24},
  {x:2,y:29},{x:20,y:29},{x:46,y:29},
  {x:2,y:34},{x:46,y:34},{x:15,y:34},{x:31,y:34}
];

// ── Token helpers ─────────────────────────────────────────────────────────────
function makeGameToken(lobbyId, pid) {
  const ts = Date.now();
  const data = `${lobbyId}:${pid}:${ts}`;
  const sig = crypto.createHmac('sha256', GAME_SECRET || 'dev').update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');
}

function validateGameToken(token, lobbyId, pid) {
  try {
    const { data, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expected = crypto.createHmac('sha256', GAME_SECRET).update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const parts = data.split(':');
    if (parts[0] !== lobbyId) return false;
    if (pid && parts[1] !== pid) return false; // token must be for this exact wallet
    if (Date.now() - parseInt(parts[2]) > 7200000) return false; // 2h expiry
    return true;
  } catch { return false; }
}

// ── Room helpers ──────────────────────────────────────────────────────────────
function freshMaze() { return MAZE_BASE.map(r => [...r]); }

function rndPowSpot(maze) {
  const free = POW_SPOTS.filter(s => maze[s.y][s.x] === 0);
  if (!free.length) return null;
  return free[Math.floor(Math.random() * free.length)];
}

function placePowerups(maze) {
  const used = new Set();
  const place = (type, n) => {
    for (let i = 0; i < n; i++) {
      const s = rndPowSpot(maze);
      if (s && !used.has(`${s.x},${s.y}`)) { maze[s.y][s.x] = type; used.add(`${s.x},${s.y}`); }
    }
  };
  place(3, 5); place(4, 5);
}

// ── Lobby defs (match client) ─────────────────────────────────────────────────
const LOBBY_IDS = new Set(['free-lobby', 'paid-lobby-1', 'paid-lobby-5', 'paid-lobby-25']);

// ── Rooms ─────────────────────────────────────────────────────────────────────
const rooms = new Map();

function getOrCreateRoom(lobbyId) {
  if (!rooms.has(lobbyId)) {
    const maze = freshMaze();
    placePowerups(maze);
    rooms.set(lobbyId, {
      lobbyId, maze,
      players: new Map(),   // pid → player
      powRespawnQ: [],
      eatLog: [],
      frm: 0, pkTick: 0, pkSent: 0,
      interval: null
    });
  }
  return rooms.get(lobbyId);
}

let _si = 0;
function nextSpawn(room) {
  const occupied = room ? [...room.players.values()].filter(p => p.alive) : [];
  if (occupied.length === 0) return SPAWNS[_si++ % SPAWNS.length];
  let best = SPAWNS[0], bestDist = -1;
  for (const s of SPAWNS) {
    let minD = Infinity;
    for (const p of occupied) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < minD) minD = d;
    }
    if (minD > bestDist) { bestDist = minD; best = s; }
  }
  return { x: best.x, y: best.y };
}

// ── Game logic (authoritative — runs on server) ───────────────────────────────
function movePlayer(p, room) {
  if (!p.alive) return;
  // Accumulator-based speed — matches client moveP() so speed is identical to old host-side.
  // Base 0.2185/tick → ~4.6 ticks/cell → ~6.6 cells/sec at TICK_MS=33.
  const spd = p.pep && p.pet > 0 ? 0.2185 * 1.55 : p.pow && p.pt > 0 ? 0.2185 * 1.25 : 0.2185;
  p.mc = (p.mc || 0) + spd;
  if (p.mc < 1) {
    // Powerup timers still tick even when not moving a cell
    if (p.pow && p.pt > 0 && --p.pt <= 0) p.pow = false;
    if (p.pep && p.pet > 0 && --p.pet <= 0) p.pep = false;
    return;
  }
  p.mc -= 1;
  // Try to turn if requested
  if (p.nx !== 0 || p.ny !== 0) {
    const tnx = p.x + p.nx, tny = p.y + p.ny;
    const tunnelTurn = p.y === 17 && tny === 17 && (tnx < 0 || tnx >= C);
    if (tunnelTurn || (tnx >= 0 && tnx < C && tny >= 0 && tny < R && room.maze[tny][tnx] !== 1)) {
      p.dx = p.nx; p.dy = p.ny;
    }
  }
  // Move in current direction
  const tx = p.x + p.dx, ty = p.y + p.dy;
  if (p.y === 17 && ty === 17 && (tx < 0 || tx >= C)) {
    // Tunnel wrap: row 17 horizontal exit
    p.prevX = p.x; p.prevY = p.y;
    p.x = tx < 0 ? C - 1 : 0;
    p.y = 17;
  } else if (tx >= 0 && tx < C && ty >= 0 && ty < R && room.maze[ty][tx] !== 1) {
    p.prevX = p.x; p.prevY = p.y;
    p.x = tx; p.y = ty;
  }
  // Powerup timers
  if (p.pow && p.pt > 0 && --p.pt <= 0) p.pow = false;
  if (p.pep && p.pet > 0 && --p.pet <= 0) p.pep = false;
}

function eatCell(p, room) {
  const v = room.maze[p.y][p.x];
  if (v === 2) {
    room.maze[p.y][p.x] = 0; p.sc += 10;
    room.eatLog.push([p.y, p.x, 0]);
  } else if (v === 3 || v === 4) {
    const type = v === 3 ? 'cherry' : 'pepper';
    const isActive = type === 'cherry' ? p.pow : p.pep;
    if (!p.held) p.held = [];
    const canPickup = !isActive && !p.held.includes(type) && p.held.length < 2;
    if (canPickup) {
      room.maze[p.y][p.x] = 0; p.sc += 50;
      p.held.push(type);
      room.eatLog.push([p.y, p.x, 0]);
      room.powRespawnQ.push({ type: v, at: room.frm + (v === 3 ? CHERRY_RESPAWN : PEPPER_RESPAWN) });
    }
  }
}

function checkCollisions(room, io) {
  const alive = [...room.players.values()].filter(p => p.alive);
  const now = Date.now();
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      // Skip kill if either player has active spawn protection
      if ((a.spawnProt && now < a.spawnProt) || (b.spawnProt && now < b.spawnProt)) continue;
      const same = a.x === b.x && a.y === b.y;
      const crossed = a.x === (b.prevX ?? b.x) && a.y === (b.prevY ?? b.y) &&
                      b.x === (a.prevX ?? a.x) && b.y === (a.prevY ?? a.y);
      if (!same && !crossed) continue;
      if (a.pow && !b.pow) { a.sc += 300; elim(b, a.id, room, io); }
      else if (b.pow && !a.pow) { b.sc += 300; elim(a, b.id, room, io); }
    }
  }
}

function elim(victim, killerId, room, io) {
  victim.alive = false;
  // Sign the kill so settle.js can verify it came from the real game server, not a console call
  const killTs = Date.now();
  const killProof = GAME_SECRET
    ? crypto.createHmac('sha256', GAME_SECRET).update(`${killerId}:${victim.id}:${killTs}`).digest('hex')
    : null;
  io.to(room.lobbyId).emit('elim', { id: victim.id, killerId, victimSol: victim.sol || 0, killProof, killTs });
}

function tick(room, io) {
  room.frm++;
  // Powerup respawns
  for (let i = room.powRespawnQ.length - 1; i >= 0; i--) {
    const r = room.powRespawnQ[i];
    if (room.frm >= r.at) {
      const s = rndPowSpot(room.maze);
      if (s) { room.maze[s.y][s.x] = r.type; room.eatLog.push([s.y, s.x, r.type]); }
      room.powRespawnQ.splice(i, 1);
    }
  }
  room.players.forEach(p => { movePlayer(p, room); eatCell(p, room); });
  checkCollisions(room, io);

  // Broadcast at ~20fps (every 2 ticks)
  room.pkTick++;
  if (room.pkTick % 2 === 0) {
    room.pkSent++;
    const ps = [];
    room.players.forEach((p, id) => {
      const hN = (p.held?.includes('cherry') ? 1 : 0) | (p.held?.includes('pepper') ? 2 : 0);
      ps.push([id, p.x, p.y, p.dx, p.dy, p.sc, p.alive ? 1 : 0,
               p.pow ? 1 : 0, p.pt || 0, p.pep ? 1 : 0, p.pet || 0, hN,
               p.spawnProt && Date.now() < p.spawnProt ? 1 : 0]);
    });
    const msg = { ps };
    if (room.pkSent % 40 === 0) msg.maze = room.maze;
    else if (room.eatLog.length) { msg.eat = room.eatLog; room.eatLog = []; }
    else room.eatLog = [];
    io.to(room.lobbyId).emit('s', msg);
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────
const app = express();
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 8000,
  transports: ['websocket', 'polling']
});

io.on('connection', socket => {
  const { gameToken, lobbyId, pid, name, color, wagerSol } = socket.handshake.auth;

  // Validate lobby
  if (!lobbyId) { socket.disconnect(); return; }
  const isPaid = lobbyId !== 'free-lobby';

  const room = getOrCreateRoom(lobbyId);
  const existing = room.players.get(pid);

  // Paid lobby gate — fail CLOSED: no GAME_SECRET means misconfigured server, deny entry
  if (isPaid) {
    console.log(`[${lobbyId}] connection pid=${pid&&pid.slice(0,8)} hasToken=${!!gameToken} existing=${!!existing} gsSet=${!!GAME_SECRET}`);
    if (!GAME_SECRET) {
      socket.emit('err', 'Server not configured for paid lobbies — contact admin');
      socket.disconnect(); return;
    }
    // Reconnecting players (already in room) skip token re-check — their token was validated on first join
    if (!existing) {
      const tokenValid = validateGameToken(gameToken, lobbyId, pid);
      console.log(`[${lobbyId}] token valid=${tokenValid} alreadyUsed=${_usedGameTokens.has(gameToken)}`);
      if (!tokenValid) {
        socket.emit('err', 'Invalid entry token — pay to join');
        socket.disconnect(); return;
      }
      if (_usedGameTokens.has(gameToken)) {
        // Same player reconnecting after a drop — allow re-entry (token is HMAC-tied to this pid)
        console.log(`[${lobbyId}] allowing reconnect for pid=${pid&&pid.slice(0,8)} with previously-used token`);
      } else {
        _usedGameTokens.add(gameToken);
      }
    }
  }

  socket.join(lobbyId);

  // Reconnect: if pid already in room, just update socketId and keep all game state
  let player;
  if (existing) {
    existing.socketId = socket.id;
    player = existing;
  } else {
    const spawn = nextSpawn(room);
    player = {
      id: pid, socketId: socket.id,
      name: name || 'Player', color: color || '#FFD700',
      x: spawn.x, y: spawn.y,
      dx: 0, dy: 0, nx: 0, ny: 0,
      prevX: spawn.x, prevY: spawn.y,
      sc: 0, alive: true, mc: 0,
      pow: false, pt: 0, pep: false, pet: 0,
      held: ['cherry', 'pepper'], sol: wagerSol || 0,
      num: room.players.size,
      spawnProt: Date.now() + 2500
    };
    room.players.set(pid, player);
  }

  // Send full initial state to joining/rejoining player
  socket.emit('init', {
    pid,
    maze: room.maze,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, dx: p.dx, dy: p.dy,
      sc: p.sc, alive: p.alive, num: p.num, sol: p.sol
    }))
  });

  // Only announce to others if this is a fresh join (not a reconnect)
  if (!existing) {
    socket.to(lobbyId).emit('join', {
      id: pid, name: player.name, color: player.color,
      x: player.x, y: player.y, num: player.num, sol: player.sol
    });
  }

  // Start game loop if not already running
  if (!room.interval) {
    room.interval = setInterval(() => tick(room, io), TICK_MS);
    console.log(`[${lobbyId}] game loop started`);
  }

  // ── Input ─────────────────────────────────────────────────────
  socket.on('in', ({ dx, dy }) => {
    const p = room.players.get(pid);
    if (!p || !p.alive) return;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return; // reject invalid
    p.nx = dx | 0; p.ny = dy | 0;
  });

  // ── Use powerup ───────────────────────────────────────────────
  socket.on('pow', ({ type }) => {
    const p = room.players.get(pid);
    if (!p || !p.alive || !p.held?.includes(type)) return;
    p.held = p.held.filter(h => h !== type);
    if (type === 'cherry') { p.pow = true; p.pt = CHERRY_TICKS; }
    else if (type === 'pepper') { p.pep = true; p.pet = PEPPER_TICKS; }
  });

  // ── Rejoin (paid lobby) ───────────────────────────────────────
  socket.on('ping_req', (ts) => socket.emit('pong_res', ts));

  socket.on('rejoin', ({ gameToken: rt }) => {
    if (isPaid && GAME_SECRET && !validateGameToken(rt, lobbyId, pid)) return;
    const p = room.players.get(pid);
    if (!p) return;
    const s = nextSpawn(room);
    p.x = s.x; p.y = s.y; p.dx = 0; p.dy = 0; p.nx = 0; p.ny = 0; p.alive = true; p.sc = 0;
    p.spawnProt = Date.now() + 2500;
    p.pow = false; p.pt = 0; p.pep = false; p.pet = 0; p.held = ['cherry', 'pepper'];
    // Include spawn coords so clients snap immediately instead of waiting for the next state tick
    io.to(lobbyId).emit('rejoin', { id: pid, x: s.x, y: s.y });
  });

  // ── Chat ──────────────────────────────────────────────────────
  socket.on('chat', ({ text }) => {
    if (typeof text !== 'string') return;
    io.to(lobbyId).emit('chat', { id: pid, name: player.name, text: text.slice(0, 100) });
  });

  // ── Spectate ──────────────────────────────────────────────────
  socket.on('spectate', () => {
    const p = room.players.get(pid);
    if (p) p.alive = false;
    io.to(lobbyId).emit('spectate', { id: pid });
  });

  // ── Disconnect ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    room.players.delete(pid);
    io.to(lobbyId).emit('leave', { id: pid });
    console.log(`[${lobbyId}] ${name} left — ${room.players.size} remaining`);
    if (room.players.size === 0) {
      clearInterval(room.interval);
      room.interval = null;
      rooms.delete(lobbyId);
      console.log(`[${lobbyId}] room closed`);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`PAC ARENA game server listening on :${PORT}`);
});
