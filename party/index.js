// PAC ARENA — Partykit live lobby server
// Persistent 24/7 rooms: "free-lobby", "gold-lobby", "diamond-lobby"
// N players; first to connect is host (runs game logic on their browser).
// Server just assigns IDs/colors/spawns and relays messages.

const COLORS = ['#FFD700','#FF69B4','#00BFFF','#FF4500','#39FF14','#FF1493','#00FFFF','#DA70D6'];
const SPAWNS = [
  [14,18],[13,3],[1,1],[26,1],[1,5],[26,5],
  [1,10],[26,10],[5,3],[22,3],[5,18],[22,18],
  [13,6],[14,6],[7,10],[20,10]
];

export default class GameRoom {
  constructor(room) {
    this.room = room;
    this.players = new Map(); // conn.id → { id, num, color, spawn, isHost }
    this.hostId = null;
    this.nextNum = 0;
  }

  getSpawn() {
    const used = new Set([...this.players.values()].map(p => p.spawn.join(',')));
    const free = SPAWNS.filter(s => !used.has(s.join(',')));
    const pool = free.length > 0 ? free : SPAWNS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  onConnect(conn) {
    const isHost = this.players.size === 0;
    if (isHost) this.hostId = conn.id;

    const info = {
      id: conn.id,
      num: this.nextNum++,
      color: COLORS[this.players.size % COLORS.length],
      spawn: this.getSpawn(),
      isHost
    };
    this.players.set(conn.id, info);

    // Send new player: their own info + all current players (including themselves)
    conn.send(JSON.stringify({
      t: 'joined',
      you: info,
      all: [...this.players.values()]
    }));

    // Tell existing players about the newcomer
    this.room.broadcast(JSON.stringify({
      t: 'peer_joined',
      player: info
    }), [conn.id]);
  }

  onMessage(message, sender) {
    // Pure relay — host sends game state, others send inputs
    this.room.broadcast(message, [sender.id]);
  }

  onClose(conn) {
    this.players.delete(conn.id);

    // Promote next player to host if host left
    if (conn.id === this.hostId && this.players.size > 0) {
      const newHostId = [...this.players.keys()][0];
      this.players.get(newHostId).isHost = true;
      this.hostId = newHostId;
      const newHostConn = [...this.room.getConnections()].find(c => c.id === newHostId);
      if (newHostConn) newHostConn.send(JSON.stringify({ t: 'become_host' }));
    }

    this.room.broadcast(JSON.stringify({ t: 'peer_left', id: conn.id }));
  }
}
