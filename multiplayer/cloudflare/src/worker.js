// Enceladus shared-world relay on Cloudflare (Workers + one Durable Object). Same protocol and limits as ../server.mjs
// (see ../PROTOCOL.md): clients send where they are, the relay sends each one the players nearest them, 10 times a second.
// One Durable Object ("World") holds everyone who is connected, in memory only. Nothing is written to storage.
const TICK_MS = 100, MAX_PEERS_SENT = 60, IDLE_MS = 20000, MAX_MSG_BYTES = 1024, R_ENC = 252100;
const RATE = { perSec: 30, burst: 60 };
const MODES = new Set(['ship', 'walk', 'rover', 'skim', 'orbit']);
const CLIENTS = new Set(['web', 'ue5', 'other']);
const num = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null);
const cleanName = s => (typeof s === 'string' ? s.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 24) : '') || null;
const xyz = s => { const r = R_ENC + s.h, la = s.lat * Math.PI / 180, lo = s.lon * Math.PI / 180; return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)]; };

export default {
  async fetch(req, env) {
    const allow = (env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin');
    const originOk = !origin || allow.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Enceladus shared-world relay. Protocol v1. Connect with a WebSocket.\n',
        { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (!originOk) return new Response('origin not allowed', { status: 403 });
    const world = env.WORLD.get(env.WORLD.idFromName('enceladus'));
    return world.fetch(req);
  },
};

export class World {
  constructor(state, env) {
    this.env = env;
    this.max = +(env.MAX_CLIENTS || 300);
    this.players = new Map();   // id -> { ws, id, name, client, state, seen, tokens, last }
    this.timer = null;
  }

  async fetch(req) {
    const pair = new WebSocketPair(), [client, ws] = Object.values(pair);
    ws.accept();
    if (this.players.size >= this.max) { ws.close(1013, 'full, try again later'); return new Response(null, { status: 101, webSocket: client }); }
    const id = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
    const p = { ws, id, name: `Pilot ${id.slice(0, 4).toUpperCase()}`, client: 'other', state: null, seen: Date.now(), tokens: RATE.burst, last: Date.now() };
    this.players.set(id, p);
    ws.addEventListener('message', e => this.onMessage(p, e.data));
    const bye = () => { if (this.players.delete(id)) this.broadcast({ type: 'left', id }); if (!this.players.size) this.stop(); };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
    this.start();
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(p, data) {
    const now = Date.now();
    p.tokens = Math.min(RATE.burst, p.tokens + (now - p.last) / 1000 * RATE.perSec); p.last = now;
    if (p.tokens < 1) return;               // over the rate limit: ignore
    p.tokens -= 1;
    if (typeof data !== 'string' || data.length > MAX_MSG_BYTES) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    p.seen = now;
    if (m.type === 'hello') {
      p.name = cleanName(m.name) || p.name;
      p.client = CLIENTS.has(m.client) ? m.client : 'other';
      this.send(p, { type: 'welcome', v: 1, id: p.id, name: p.name, tickMs: TICK_MS });
    } else if (m.type === 'state') {
      const lat = num(m.lat, -90, 90), lon = num(m.lon, -180, 180), h = num(m.h, -50000, 2000000);
      if (lat === null || lon === null || h === null) return;
      p.state = { lat, lon, h, hd: num(m.hd, -360, 360) ?? 0, pt: num(m.pt, -90, 90) ?? 0, rl: num(m.rl, -180, 180) ?? 0,
        spd: num(m.spd, 0, 1e5) ?? 0, mode: MODES.has(m.mode) ? m.mode : 'ship' };
    } else if (m.type === 'name') {
      p.name = cleanName(m.name) || p.name;
    }
  }

  send(p, msg) { try { p.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch {} }
  broadcast(msg) { const s = JSON.stringify(msg); for (const p of this.players.values()) this.send(p, s); }
  start() { if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS); }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  tick() {
    const now = Date.now(), live = [];
    for (const p of [...this.players.values()]) {
      if (now - p.seen > IDLE_MS) { try { p.ws.close(1000, 'idle'); } catch {} this.players.delete(p.id); this.broadcast({ type: 'left', id: p.id }); continue; }
      if (p.state) live.push({ p, x: xyz(p.state) });
    }
    if (!this.players.size) { this.stop(); return; }
    for (const me of this.players.values()) {
      const mine = me.state && xyz(me.state);
      let list = live.filter(o => o.p !== me);
      if (mine && list.length > MAX_PEERS_SENT) {
        const d2 = o => (o.x[0] - mine[0]) ** 2 + (o.x[1] - mine[1]) ** 2 + (o.x[2] - mine[2]) ** 2;
        list = list.sort((a, b) => d2(a) - d2(b)).slice(0, MAX_PEERS_SENT);
      } else list = list.slice(0, MAX_PEERS_SENT);
      this.send(me, { type: 'peers', t: now, online: this.players.size, peers: list.map(({ p }) => ({ id: p.id, name: p.name, client: p.client, ...p.state })) });
    }
  }
}
