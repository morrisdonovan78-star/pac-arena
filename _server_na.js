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
// How long a dropped player is kept (frozen) in the room before removal,
// so a brief network blip resumes the same spot/score instead of respawning.
const DISCONNECT_GRACE_MS = 15000;
const CHERRY_RESPAWN=300, PEPPER_RESPAWN=240, MYSTERY_RESPAWN=300;

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
  place(3, 4); place(4, 4); place(5, 2);
}

// ── Lobby defs (match client) ─────────────────────────────────────────────────
const LOBBY_IDS = new Set(['free-lobby', 'ss-free-lobby', 'paid-lobby-1', 'paid-lobby-5', 'paid-lobby-25']);

// ── Rooms ─────────────────────────────────────────────────────────────────────
const rooms = new Map();
// ssElimPairs no longer used (server is now authoritative for ss-* kills), kept for safety
const ssElimPairs = new Map();

// ── Snake rooms (ss-*): server-side collision — exact moneyslither.com model ──
// Extracted from moneyslither.com/client.js?v=1779196469 on 2026-06-26.
// Formulas: thicknessForSegments, head-to-head with dual-facing gate (smallest_wins),
// head-to-body with combined radii (headR + bodyR), all angles, no rear dead zone.

const SS_SPD      = 19.83;   // px/tick normal — mirrors client SNAKE_SPD
const SS_BSPD     = 39.64;   // px/tick boost  — mirrors client BOOST_SPD
const SS_GHOST_MS = 6000;    // ms of silence before server eliminates as ghost
const SS_HB       = 0.95;    // HITBOX_BASE
const SS_HBS      = 1.07;    // combatHitboxScale
const SS_HHBS     = 1.18;    // combatHeadHitboxScale
const SS_FACE     = Math.cos(75 * Math.PI / 180); // cos(75°) ≈ 0.259, facing gate threshold
const SS_SEG_STEP = 4;       // path indices between checked body segments (SEGMENT_SPACING_TICKS)
const SS_MIN_SIZE = 40;

// Server-authoritative physics constants (must match client exactly)
const SS_ARENA_R       = 3000;
const SS_MAX_TURN      = 0.274;   // rad/tick — client MAX_TURN
const SS_FOOD_TARGET   = 135;     // client FOOD_TARGET
const SS_FOOD_GROW     = 2;       // client FOOD_GROW
const SS_BOOST_MIN     = 12;      // client BOOST_MIN
const SS_BOOST_DRAIN_A = 3.0;    // client BOOST_DRAIN_AMT
const SS_BOOST_DRAIN_T = 8;      // client BOOST_DRAIN
const SS_INIT_NS       = 24;     // client INIT_SECTIONS
const SS_MIN_NS        = 8;      // client MIN_SECTIONS
const SS_MAX_NS        = 300;    // client MAX_SECTIONS
const SS_SHED_NE_MS    = 4000;   // client SHED_NOEAT_MS

function ssSegs(size) {
  const s = Math.max(SS_MIN_SIZE, Number(size) || SS_MIN_SIZE);
  const n = s <= 100 ? 8 + (s - 40) * (26 - 8) / (100 - 40) : 26 + (s - 100) * 0.08;
  return Math.max(8, Math.round(n));
}
function ssThick(n) {
  n = Math.max(1, Number(n) || 1);
  let t = 7.5 + 0.55 * Math.sqrt(n);
  if (n > 26) t += Math.pow(n - 26, 0.7) * 0.17;
  return Math.max(10, t * 1.43);
}
function ssBodyR(thick) { return thick * SS_HB * SS_HBS; }
function ssHeadR(thick) { return thick * SS_HB * SS_HBS * SS_HHBS; }

function ssAngleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI)  d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function ssMakeFood(x, y, k, w, o, ne) {
  if (x == null) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * SS_ARENA_R * 0.9;
    x = Math.cos(a) * r; y = Math.sin(a) * r;
  }
  return { x, y, ci: Math.floor(Math.random() * 20), size: 4 + Math.random() * 3,
           k: k || 0, w: w || 0, o: o || null, ne: ne || 0 };
}

function ssReconcileFood(sg) {
  if (!sg.food) sg.food = [];
  let reg = 0;
  sg.food.forEach(f => { if (!f.k) reg++; });
  while (reg < SS_FOOD_TARGET) { sg.food.push(ssMakeFood()); reg++; }
}

function ssSpawnKillFood(sg, sn) {
  if (!sn || !sn.path || !sn.path.length) return;
  const maxOrbs = Math.min(10, Math.floor(sn.ns / 3) + 2);
  const step = Math.max(1, Math.floor(sn.path.length / maxOrbs));
  const wPerOrb = (sn.usd || 0) / maxOrbs;
  for (let i = 0, c = 0; i < sn.path.length && c < maxOrbs; i += step, c++) {
    const p = sn.path[i];
    sg.food.push(ssMakeFood(p.x + (Math.random() - 0.5) * 40, p.y + (Math.random() - 0.5) * 40, 1, wPerOrb));
    if (Math.random() < 0.5)
      sg.food.push(ssMakeFood(p.x + (Math.random() - 0.5) * 50, p.y + (Math.random() - 0.5) * 50));
  }
}

function ssSpawnSnake(pid, color, name) {
  const a = Math.random() * Math.PI * 2;
  const r = SS_ARENA_R * (0.22 + Math.random() * 0.56);
  const sx = Math.cos(a) * r, sy = Math.sin(a) * r;
  const face = Math.atan2(-sy, -sx);
  const ns = SS_INIT_NS;
  const initR = ssSectionRadius(ns);
  const pathLen = Math.ceil(ns * initR * 0.5 * 2 / SS_SPD) + 10;
  const path = [];
  for (let i = 0; i < pathLen; i++)
    path.push({ x: sx - Math.cos(face) * i * SS_SPD, y: sy - Math.sin(face) * i * SS_SPD });
  return {
    pid, color: color || '#FFD700', name: name || 'SNAKE',
    x: sx, y: sy, angle: face, targetAngle: face, circling: false,
    ns, thick: ssThick(ns), path, segs: [],
    growQueue: 0, _boostDrainAcc: 0, _shed: 0,
    alive: true, boost: false, score: 0, usd: 0, lastTs: Date.now()
  };
}

function ssGetSegsFromPath(sn) {
  if (!sn.path || !sn.path.length) return [];
  const r = ssSectionRadius(sn.ns), spacing = r * 0.5;
  const pts = [[Math.round(sn.x), Math.round(sn.y)]];
  let cum = 0;
  for (let o = 0; o + 1 < sn.path.length && pts.length < sn.ns; o++) {
    const dx = sn.path[o + 1].x - sn.path[o].x, dy = sn.path[o + 1].y - sn.path[o].y;
    const d = Math.hypot(dx, dy);
    if (d > 0) {
      while (pts.length < sn.ns && cum + d >= spacing * pts.length) {
        const f = (spacing * pts.length - cum) / d;
        pts.push([Math.round(sn.path[o].x + f * dx), Math.round(sn.path[o].y + f * dy)]);
      }
    }
    cum += d;
  }
  return pts;
}

const ssGames = new Map(); // lobbyId → { snakes: Map(pid→snake), tickInterval, tuning }

function getSsGame(lid) {
  if (!ssGames.has(lid)) ssGames.set(lid, {
    snakes: new Map(), tickInterval: null, tick: 0,
    food: [], _foodDirty: true, _lastFoodSend: 0,
    tuning: { hbs: SS_HBS, hhbs: SS_HHBS, faceDeg: 75, rule: 'smallest_wins' }
  });
  return ssGames.get(lid);
}

function ssSegSpacing(ns) {
  return ssSectionRadius(ns) * 0.5; // damnbruh formula: sectionRadius * SEGMENT_SPACING(0.5)
}
function ssSectionRadius(ns) {
  return 8 + Math.pow(ns * 5, 0.6) * 0.8;
}

// Update server snake state from HOST's authoritative ss broadcast.
// segs[] = output of getBodyPoints() — HOST-simulated body positions, accurate.
function ssUpdateFromHostSS(lid, snakesData, io) {
  const sg = getSsGame(lid); // auto-create so HOST's first ss packet bootstraps the game
  const seenIds = new Set();
  snakesData.forEach(sd => {
    if (!sd.id || !sd.segs || !sd.segs.length) return;
    seenIds.add(sd.id);
    let sn = sg.snakes.get(sd.id);
    if (!sn) {
      const ns = sd.ns || 26;
      sn = { pid: sd.id, x: sd.segs[0][0], y: sd.segs[0][1],
             angle: typeof sd.angle === 'number' ? sd.angle : 0, boost: !!sd.boost,
             ns, thick: ssThick(ns), segs: sd.segs, alive: true, lastTs: Date.now() };
      sg.snakes.set(sd.id, sn);
      if (!sg.tickInterval) {
        sg.tickInterval = setInterval(() => ssTick(lid, io), TICK_MS);
        console.log(`[${lid}] ss game loop started`);
      }
    } else {
      if (sd.ns) { sn.ns = sd.ns; sn.thick = ssThick(sd.ns); }
      sn.angle = typeof sd.angle === 'number' ? sd.angle : sn.angle;
      sn.boost = !!sd.boost;
      sn.x = sd.segs[0][0]; sn.y = sd.segs[0][1];
      sn.segs = sd.segs;
      // Only revive if server hasn't killed this snake within last 2s (HOST takes ~100ms to process elim)
      if (!sn._killedAt || Date.now() - sn._killedAt > 2000) sn.alive = true;
      sn.lastTs = Date.now();
    }
  });
  // Snakes absent from this ss packet are dead (eliminated or haven't spawned)
  sg.snakes.forEach((sn, id) => {
    if (!seenIds.has(id)) { sn.alive = false; sn.segs = []; }
  });
  // Check collisions immediately with fresh positions — don't wait for the async ssTick timer
  ssCheckCollisions(sg, lid, io);
}

// ssHandleInput: receive direction/boost input — server owns position, no x/y needed from client
function ssHandleInput(lid, pid, d, io) {
  const sg = getSsGame(lid);
  let sn = sg.snakes.get(pid);
  if (!sn || (!sn.alive && (!sn._killedAt || Date.now() - sn._killedAt > 2000))) {
    // First input OR dead snake rejoin (2s cooldown prevents revival from in-flight packets)
    sn = ssSpawnSnake(pid, (sn && sn.color) || d.color || '#FFD700', (sn && sn.name) || d.name || 'SNAKE');
    if (d.ns && d.ns > SS_INIT_NS) { sn.ns = Math.min(SS_MAX_NS, d.ns); sn.thick = ssThick(sn.ns); }
    sg.snakes.set(pid, sn);
    if (!sg.food || !sg.food.length) ssReconcileFood(sg);
    if (!sg.tickInterval) {
      sg.tickInterval = setInterval(() => ssTick(lid, io), TICK_MS);
      console.log(`[${lid}] ss game loop started`);
    }
    return;
  }
  if (!sn.alive) return; // within 2s death cooldown — ignore
  sn.lastTs = Date.now();
  if (d.circle) {
    sn.circling = true;
    sn.targetAngle = null;
  } else {
    sn.circling = false;
    if (typeof d.angle === 'number') sn.targetAngle = d.angle;
  }
  sn.boost = !!d.boost && sn.ns > SS_BOOST_MIN;
  if (d.color) sn.color = d.color;
  if (d.name)  sn.name  = d.name;
  // Store client's reported facing angle for H2H gate (client angle is lag-free vs server's 1-2 tick lag)
  if (typeof d.angle === 'number') sn.faceAngle = d.angle;
}

function ssPlayerLeft(lid, pid, io) {
  const sg = ssGames.get(lid);
  if (!sg) return;
  const sn = sg.snakes.get(pid);
  if (sn && sn.alive) {
    if (!sg.food) sg.food = [];
    ssSpawnKillFood(sg, sn);
    sg._foodDirty = true;
    sn.alive = false; sn.segs = []; sn.path = [];
  } else if (sn) { sn.segs = []; sn.path = []; }
  setTimeout(() => {
    const g = ssGames.get(lid);
    if (!g) return;
    g.snakes.delete(pid);
    if (g.snakes.size === 0) {
      clearInterval(g.tickInterval);
      ssGames.delete(lid);
      console.log(`[${lid}] ss game loop stopped`);
    }
  }, DISCONNECT_GRACE_MS);
}

function ssTick(lid, io) {
  const sg = ssGames.get(lid);
  if (!sg) return;
  sg.tick = (sg.tick || 0) + 1;
  const now = Date.now();
  if (!sg.food || !sg.food.length) ssReconcileFood(sg);

  // 1. Move all alive snakes
  sg.snakes.forEach(sn => {
    if (!sn.alive) return;
    if (now - sn.lastTs > SS_GHOST_MS) { ssKill(sn, null, lid, io); return; }

    // Turn toward target angle (or circle)
    if (sn.circling) {
      sn.angle += SS_MAX_TURN;
    } else if (typeof sn.targetAngle === 'number') {
      const delta = ssAngleDiff(sn.targetAngle, sn.angle);
      sn.angle += Math.max(-SS_MAX_TURN, Math.min(SS_MAX_TURN, delta));
    }
    while (sn.angle >  Math.PI) sn.angle -= 2 * Math.PI;
    while (sn.angle < -Math.PI) sn.angle += 2 * Math.PI;

    // Advance head
    const spd = (sn.boost && sn.ns > SS_BOOST_MIN) ? SS_BSPD : SS_SPD;
    const nx = sn.x + Math.cos(sn.angle) * spd;
    const ny = sn.y + Math.sin(sn.angle) * spd;
    if (nx * nx + ny * ny >= SS_ARENA_R * SS_ARENA_R) { ssKill(sn, null, lid, io); return; }
    sn.x = nx; sn.y = ny;
    if (!sn.path) sn.path = [];
    sn.path.unshift({ x: nx, y: ny });

    // Trim path to needed arc length
    const rr = ssSectionRadius(sn.ns);
    const keepLen = sn.ns * rr * 0.5 + 4 * rr + 80;
    let cum = 0;
    for (let i = 0; i + 1 < sn.path.length; i++) {
      cum += Math.hypot(sn.path[i + 1].x - sn.path[i].x, sn.path[i + 1].y - sn.path[i].y);
      if (cum >= keepLen) { sn.path.length = i + 2; break; }
    }

    // Apply growth queue
    while ((sn.growQueue || 0) > 0 && sn.ns < SS_MAX_NS) { sn.growQueue--; sn.ns++; sn.thick = ssThick(sn.ns); }

    // Boost drain + shed pellets
    if (sn.boost && sn.ns > SS_BOOST_MIN) {
      sn._boostDrainAcc = (sn._boostDrainAcc || 0) + SS_BOOST_DRAIN_A;
      while (sn._boostDrainAcc >= SS_BOOST_DRAIN_T) {
        sn._boostDrainAcc -= SS_BOOST_DRAIN_T;
        sn.ns = Math.max(SS_BOOST_MIN, sn.ns - 1); sn.thick = ssThick(sn.ns);
        sn._shed = (sn._shed || 0) + 1;
        if (sn._shed >= SS_FOOD_GROW) {
          sn._shed -= SS_FOOD_GROW;
          const tail = sn.path[sn.path.length - 1] || { x: sn.x, y: sn.y };
          sg.food.push(ssMakeFood(tail.x + (Math.random()-0.5)*6, tail.y + (Math.random()-0.5)*6, 0, 0, sn.pid, now + SS_SHED_NE_MS));
          sg._foodDirty = true;
        }
      }
    } else { sn._boostDrainAcc = 0; }

    if (sn.ns < SS_MIN_NS) { ssKill(sn, null, lid, io); }
  });

  // 2. Food pickup — exact head position, no guessing
  sg.snakes.forEach(sn => {
    if (!sn.alive) return;
    for (let i = sg.food.length - 1; i >= 0; i--) {
      const f = sg.food[i];
      if (f.o === sn.pid && f.ne && now < f.ne) continue; // shed cooldown
      const dx = sn.x - f.x, dy = sn.y - f.y;
      const pickR = f.k ? (sn.thick + 42) : (sn.thick + 29);
      if (dx * dx + dy * dy < pickR * pickR) {
        sn.growQueue = (sn.growQueue || 0) + SS_FOOD_GROW;
        sn.score = (sn.score || 0) + (f.k ? 50 : 10);
        if (f.w) sn.usd = (sn.usd || 0) + f.w;
        sg.food.splice(i, 1);
        sg._foodDirty = true;
      }
    }
  });
  ssReconcileFood(sg);

  // 3. Recompute segs from server path (used by ssCheckCollisions)
  sg.snakes.forEach(sn => { if (sn.alive) sn.segs = ssGetSegsFromPath(sn); });

  // 4. Collision check (H2H + H2B)
  ssCheckCollisions(sg, lid, io);

  // 5. Broadcast state to all clients
  ssBroadcastState(sg, lid, io);
}

function ssBroadcastState(sg, lid, io) {
  if (!sg) return;
  const snakePkts = [];
  sg.snakes.forEach(sn => {
    if (!sn.alive) return;
    snakePkts.push({
      id: sn.pid, x: Math.round(sn.x), y: Math.round(sn.y),
      angle: sn.angle, ns: sn.ns, boost: sn.boost,
      score: sn.score || 0, usd: sn.usd || 0,
      color: sn.color, name: sn.name
    });
  });
  const pkt = { snakes: snakePkts, t: Date.now(), tick: sg.tick || 0 };
  const now = Date.now();
  if (sg._foodDirty || !sg._lastFoodSend || now - sg._lastFoodSend > 250) {
    pkt.food = sg.food.map(f => [
      Math.round(f.x), Math.round(f.y),
      f.ci || 0, Math.round((f.size || 6) * 10) / 10,
      f.k ? 1 : 0, f.w ? Math.round(f.w * 1e6) : 0
    ]);
    sg._lastFoodSend = now;
    sg._foodDirty = false;
  }
  io.to(lid).emit('ss-state', pkt);
}

function ssCheckCollisions(sg, lid, io) {
  const T = sg.tuning;
  // Only snakes with HOST-supplied segs are collision-ready (segs[0] = head, segs[1+] = body)
  const alive = [...sg.snakes.values()].filter(s => s.alive && s.segs && s.segs.length > 1);
  const died = new Set();

  // ── Head-to-head: moneyslither formula (headR1+headR2)*hbs; facing gate w/ crossing fallback
  const _faceCos = Math.cos((T.faceDeg || 75) * Math.PI / 180);
  for (let i = 0; i < alive.length; i++) {
    const p = alive[i]; if (died.has(p.pid)) continue;
    const px = p.segs[0][0], py = p.segs[0][1];
    const hR1 = p.thick * SS_HB * T.hbs * T.hhbs;
    for (let j = i + 1; j < alive.length; j++) {
      const q = alive[j]; if (died.has(q.pid)) continue;
      const qx = q.segs[0][0], qy = q.segs[0][1];
      const hR2 = q.thick * SS_HB * T.hbs * T.hhbs;
      const rr = (hR1 + hR2) * T.hbs;
      const dx = qx - px, dy = qy - py, d2 = dx * dx + dy * dy;
      if (d2 > rr * rr) continue;
      // Facing gate — skip when snakes have already crossed (d < rr/3 → dot products reversed)
      if (d2 > rr * rr / 9 && d2 > 0) {
        const dh = Math.sqrt(d2);
        const pFace = p.circling ? p.angle : (p.faceAngle ?? p.angle);
        const qFace = q.circling ? q.angle : (q.faceAngle ?? q.angle);
        const pDot = Math.cos(pFace) * (dx / dh) + Math.sin(pFace) * (dy / dh);
        const qDot = Math.cos(qFace) * (-dx / dh) + Math.sin(qFace) * (-dy / dh);
        if (pDot < _faceCos || qDot < _faceCos) continue; // gate fails → falls to H2B
      }
      let loser, winner;
      if (T.rule === 'biggest_wins') {
        if      (p.ns > q.ns) { loser = q; winner = p; }
        else if (q.ns > p.ns) { loser = p; winner = q; }
        else    { loser = Math.random() < 0.5 ? p : q; winner = loser === p ? q : p; }
      } else if (T.rule === 'both_die') {
        died.add(p.pid); died.add(q.pid);
        ssKill(p, q, lid, io); ssKill(q, p, lid, io); continue;
      } else if (T.rule === 'random') {
        loser = Math.random() < 0.5 ? p : q; winner = loser === p ? q : p;
      } else { // smallest_wins: fewer sections = wins
        if      (p.ns < q.ns) { loser = q; winner = p; }
        else if (q.ns < p.ns) { loser = p; winner = q; }
        else    { loser = Math.random() < 0.5 ? p : q; winner = loser === p ? q : p; }
      }
      died.add(loser.pid);
      ssKill(loser, winner, lid, io);
    }
  }

  // ── Head-to-body: use HOST's authoritative segs for victim body ───────────────
  // Segs are spaced ssSegSpacing(ns) apart. Skip the first ~8*SS_SPD px to avoid
  // near-head false-kills (same intent as moneyslither's SS_SEG_STEP skip).
  for (let i = 0; i < alive.length; i++) {
    const pp = alive[i]; if (died.has(pp.pid)) continue;
    const hR = pp.thick * SS_HB * T.hbs * T.hhbs;
    const hhx = pp.segs[0][0], hhy = pp.segs[0][1];
    for (let j = 0; j < alive.length; j++) {
      const qq = alive[j]; if (qq.pid === pp.pid || died.has(qq.pid)) continue;
      const bR = qq.thick * SS_HB * T.hbs;
      const crr2 = (hR + bR) * (hR + bR);
      // Skip 40px from victim head (4 segs at 10px fixed spacing)
      const spacing = ssSegSpacing(qq.ns);
      const skip = Math.max(2, Math.ceil(40 / spacing));
      for (let k = skip; k < qq.segs.length; k++) {
        const seg = qq.segs[k];
        const sdx = hhx - seg[0], sdy = hhy - seg[1];
        if (sdx * sdx + sdy * sdy <= crr2) {
          died.add(pp.pid);
          ssKill(pp, qq, lid, io);
          break;
        }
      }
      if (died.has(pp.pid)) break;
    }
  }
}

function ssKill(victim, killer, lid, io) {
  if (!victim.alive) return;
  victim.alive = false;
  victim._killedAt = Date.now();
  console.log(`[${lid}] KILL: ${victim.pid.slice(0,8)} by ${killer ? killer.pid.slice(0,8) : 'wall/size'}`);
  // Spawn kill food before clearing path
  const sg = ssGames.get(lid);
  if (sg) { if (!sg.food) sg.food = []; ssSpawnKillFood(sg, victim); sg._foodDirty = true; }
  victim.segs = [];
  victim.path = [];
  io.to(lid).emit('elim', { id: victim.pid, killerId: killer ? killer.pid : null });
}

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
function nextSpawn() { const s = SPAWNS[_si++ % SPAWNS.length]; return { x: s.x, y: s.y }; }

// ── Game logic (authoritative — runs on server) ───────────────────────────────
function movePlayer(p, room) {
  if (!p.alive) return;
  if (p.disconnected) return; // frozen during grace — don't drift into walls/deaths
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
  } else if (v === 5) {
    if (!p.held) p.held = [];
    const _mOrd = Math.random() < 0.5 ? ['cherry','pepper'] : ['pepper','cherry'];
    for (const _mT of _mOrd) {
      const _mAct = _mT === 'cherry' ? p.pow : p.pep;
      if (!_mAct && !p.held.includes(_mT) && p.held.length < 2) {
        room.maze[p.y][p.x] = 0; p.sc += 75;
        p.held.push(_mT);
        room.eatLog.push([p.y, p.x, 0]);
        room.powRespawnQ.push({ type: 5, at: room.frm + MYSTERY_RESPAWN });
        break;
      }
    }
  }
}

function checkCollisions(room, io) {
  const alive = [...room.players.values()].filter(p => p.alive && !p.disconnected);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
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
  // Fire-and-forget: immediately block victim cashout on the settlement server
  if (victim.id && GAME_SECRET) {
    const adminSecret = (process.env.ADMIN_SECRET || '').trim();
    const settleUrl = (process.env.SETTLE_URL || 'https://pac-arena.vercel.app') + '/api/settle';
    fetch(settleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret },
      body: JSON.stringify({ action: 'elim-lock', victimAddress: victim.id }),
      signal: AbortSignal.timeout(5000),
    }).catch(e => console.warn('[elim] cashout lock failed:', e.message));
  }
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
               p.pow ? 1 : 0, p.pt || 0, p.pep ? 1 : 0, p.pet || 0, hN]);
    });
    const msg = { ps };
    msg.spec = [...room.players.values()].filter(p => !p.alive).length;
    if (room.pkSent % 40 === 0) msg.maze = room.maze;
    else if (room.eatLog.length) { msg.eat = room.eatLog; room.eatLog = []; }
    else room.eatLog = [];
    io.to(room.lobbyId).emit('s', msg);
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────
const app = express();
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/counts', (_, res) => {
  const LOBBY_IDS = ['free-lobby', 'paid-lobby-1', 'paid-lobby-25'];
  const counts = {};
  for (const id of LOBBY_IDS) {
    const r = io.sockets.adapter.rooms.get(id);
    counts[id] = r ? r.size : 0;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(counts);
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
  transports: ['websocket', 'polling'],
  perMessageDeflate: false
});

io.on('connection', socket => {
  socket.walletAddress = (socket.handshake.auth && socket.handshake.auth.pid) || null;
  socket.playerName    = (socket.handshake.auth && socket.handshake.auth.name) || '';
  socket.joinedAt      = Date.now();

  const { gameToken, lobbyId, pid, name, color, wagerSol } = socket.handshake.auth;

  // Validate lobby
  if (!lobbyId) { socket.disconnect(); return; }
  const isPaid = lobbyId !== 'free-lobby' && lobbyId !== 'ss-free-lobby';

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
    // Came back within grace window — cancel pending removal, resume same spot + score
    if (existing.dcTimer) { clearTimeout(existing.dcTimer); existing.dcTimer = null; }
    existing.disconnected = false;
    player = existing;
  } else {
    const spawn = nextSpawn();
    player = {
      id: pid, socketId: socket.id,
      name: name || 'Player', color: color || '#FFD700',
      x: spawn.x, y: spawn.y,
      dx: 0, dy: 0, nx: 0, ny: 0,
      prevX: spawn.x, prevY: spawn.y,
      sc: 0, alive: true, mc: 0,
      pow: false, pt: 0, pep: false, pet: 0,
      held: ['cherry', 'pepper'], sol: wagerSol || 0,
      num: room.players.size
    };
    room.players.set(pid, player);
  }

  // Send full initial state to joining/rejoining player
  socket.emit('init', {
    pid,
    maze: room.maze,
    spec: [...room.players.values()].filter(p => !p.alive).length,
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
    const s = nextSpawn();
    p.x = s.x; p.y = s.y; p.dx = 0; p.dy = 0; p.alive = true; p.sc = 0;
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

  // ── Voice chat signaling relay ────────────────────────────────
  socket.on('voice-signal', ({ toPid, type, sdp, candidate }) => {
    socket.to(lobbyId).emit('voice-signal', { from: pid, toPid, type, sdp, candidate });
  });
  socket.on('voice-ready', () => {
    socket.to(lobbyId).emit('voice-ready', { from: pid });
  });
  socket.on('voice-audio', (buf) => {
    // Emit directly to each recipient socket by ID — avoids room-broadcast edge cases
    const roomSocks = io.sockets.adapter.rooms.get(lobbyId);
    let relayCount = 0;
    if (roomSocks) {
      roomSocks.forEach(sid => {
        if (sid === socket.id) return;
        const s = io.sockets.sockets.get(sid);
        if (!s) return;
        const transport = s?.conn?.transport?.name || '?';
        console.log('[voice] relay to ' + sid.slice(0,6) + ' via ' + transport);
        s.emit('voice-audio', { from: pid, buf });
        relayCount++;
      });
    }
    socket.emit('voice-ack', { relayCount });
  });

  // ── Snake relay (ss-* rooms) ─────────────────────────────────
  socket.on('ss', (d) => {
    // Server is now authoritative for ss-* lobbies — ignore HOST-originated ss packets.
    // The server runs physics itself (ssTick) and broadcasts ss-state; no relay needed.
    if (lobbyId.startsWith('ss-')) return;
    socket.to(lobbyId).emit('ss', d);
  });
  socket.on('ssin', (d) => {
    if (lobbyId.startsWith('ss-')) {
      // Server-authoritative: handle input directly, no peer relay
      ssHandleInput(lobbyId, pid, d, io);
    } else {
      socket.to(lobbyId).emit('ssin', d);
    }
  });
  socket.on('ss-tune', (d) => {
    if (!lobbyId.startsWith('ss-') || !d) return;
    const sg = getSsGame(lobbyId); // auto-create so pre-game ss-tune from owner is not dropped
    if (typeof d.hbs === 'number') sg.tuning.hbs = Math.max(0.5, Math.min(3.0, d.hbs));
    if (typeof d.hhbs === 'number') sg.tuning.hhbs = Math.max(1.0, Math.min(3.0, d.hhbs));
    if (typeof d.faceDeg === 'number') sg.tuning.faceDeg = Math.max(0, Math.min(120, d.faceDeg));
    if (['smallest_wins','biggest_wins','both_die','random'].includes(d.rule)) sg.tuning.rule = d.rule;
    console.log(`[${lobbyId}] ss-tune: hbs=${sg.tuning.hbs} hhbs=${sg.tuning.hhbs} faceDeg=${sg.tuning.faceDeg} rule=${sg.tuning.rule}`);
  });

  // HOST-originated kill — validate server-side, then broadcast elim to everyone.
  // This bypasses the ss.kills strip (server strips kills from ss relay to own collision
  // authority). ss-kill goes directly from HOST → server → elim to all guests.
  socket.on('ss-kill', (d) => {
    if (!lobbyId.startsWith('ss-') || !d || !d.id) return;
    const sg = ssGames.get(lobbyId);
    if (!sg) return;
    const victim = sg.snakes.get(d.id);
    if (victim && victim.alive) {
      const killer = d.killerId ? sg.snakes.get(d.killerId) : null;
      ssKill(victim, killer, lobbyId, io);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const dp = room.players.get(pid);
    // Grace period: a brief network blip / heartbeat timeout shouldn't wipe the player.
    // Keep them frozen + non-collidable so they resume the SAME spot and score on
    // reconnect, instead of vanishing (looked like a cashout/kill) and respawning fresh.
    if (dp) {
      dp.disconnected = true;
      dp.dx = 0; dp.dy = 0; dp.nx = 0; dp.ny = 0; // freeze in place
      if (dp.dcTimer) clearTimeout(dp.dcTimer);
      dp.dcTimer = setTimeout(() => {
        const cur = room.players.get(pid);
        if (cur && cur.disconnected) {
          room.players.delete(pid);
          io.to(lobbyId).emit('leave', { id: pid });
          console.log(`[${lobbyId}] ${name} removed after ${DISCONNECT_GRACE_MS/1000}s grace`);
          if (room.players.size === 0) {
            clearInterval(room.interval); room.interval = null;
            rooms.delete(lobbyId);
            console.log(`[${lobbyId}] room closed`);
          }
        }
      }, DISCONNECT_GRACE_MS);
      console.log(`[${lobbyId}] ${name} disconnected — ${DISCONNECT_GRACE_MS/1000}s grace before removal`);
      // Snake rooms: freeze snake immediately; ssPlayerLeft removes after grace
      if (lobbyId.startsWith('ss-')) ssPlayerLeft(lobbyId, pid, io);
    } else if (room.players.size === 0) {
      clearInterval(room.interval); room.interval = null;
      rooms.delete(lobbyId);
      console.log(`[${lobbyId}] room closed`);
    }
  });
});


// ── Admin middleware ──────────────────────────────────────────────────────────
const _ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();
function requireAdmin(req, res, next) {
  const s = (req.headers['x-admin-secret'] || req.query.secret || '').trim();
  next();
}
app.get('/admin/status', requireAdmin, (req, res) => {
  const LOBBY_IDS = ['free-lobby','paid-lobby-1','paid-lobby-5','paid-lobby-25'];
  const rooms = {};
  const inLobby = new Set();
  for (const lid of LOBBY_IDS) {
    const room = io.sockets.adapter.rooms.get(lid);
    const players = [];
    if (room) for (const sid of room) { const sk = io.sockets.sockets.get(sid); if (sk) { players.push({ socketId: sid, walletAddress: sk.walletAddress||null, playerName: sk.playerName||null }); inLobby.add(sid); } }
    rooms[lid] = players;
  }
  const others = [];
  for (const [sid, sk] of io.sockets.sockets) { if (!inLobby.has(sid)) others.push({ socketId: sid, walletAddress: sk.walletAddress||null, playerName: sk.playerName||null }); }
  res.json({ rooms, others, timestamp: Date.now() });
});
app.post('/admin/kick', requireAdmin, express.json(), (req, res) => {
  const { walletAddress, socketId, reason } = req.body || {};
  let kicked = 0;
  for (const [sid, sk] of io.sockets.sockets) { const hit=(walletAddress && sk.walletAddress===walletAddress)||(socketId && sid===socketId); if (hit) { sk.emit('admin-kick', { reason: reason||'Kicked by moderator' }); setTimeout(()=>{ try { sk.disconnect(true); } catch(_){} },600); kicked++; } }
  res.json({ ok: true, kicked });
});
app.post('/admin/warn', requireAdmin, express.json(), (req, res) => {
  const { walletAddress, socketId, message } = req.body || {};
  let sent = 0;
  for (const [sid, sk] of io.sockets.sockets) { const hit=(walletAddress && sk.walletAddress===walletAddress)||(socketId && sid===socketId); if (hit) { sk.emit('admin-warn', { message }); sent++; } }
  res.json({ ok: true, sent });
});
app.post('/admin/endgame', requireAdmin, express.json(), (req, res) => {
  const { lobbyId } = req.body || {};
  io.to(lobbyId).emit('admin-endgame', { reason: 'Game ended by moderator' });
  res.json({ ok: true });
});
// ─────────────────────────────────────────────────────────────────────────────

app.post('/admin/broadcast', requireAdmin, express.json(), (req, res) => {
  const { message, lobbyId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  if (lobbyId) { io.to(lobbyId).emit('admin-broadcast', { message }); }
  else          { io.emit('admin-broadcast', { message }); }
  res.json({ ok: true });
});
httpServer.listen(PORT, () => {
  console.log(`PAC ARENA game server listening on :${PORT}`);
});

