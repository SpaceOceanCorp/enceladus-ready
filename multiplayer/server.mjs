// Enceladus shared-world relay: every client (the web globe, the Unreal game through M2EBridge) sends where it is a
// few times a second; the relay sends each client the other players near it, ten times a second. Nothing is stored.
// Message format: see PROTOCOL.md next to this file.
//
//   npm install            (once, installs the "ws" package)
//   node server.mjs        (listens on PORT, default 8790)
//
// Settings (environment variables):
//   PORT            port to listen on (default 8790)
//   ALLOW_ORIGINS   comma-separated web origins allowed to connect, e.g. "https://enceladus.spaceoceancorp.com".
//                   Default allows that site and localhost. Clients that send no Origin (the Unreal game) are allowed.
//   MAX_CLIENTS     most players at once (default 300)
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = +(process.env.PORT || 8790);
const MAX_CLIENTS = +(process.env.MAX_CLIENTS || 300);
const ALLOW = (process.env.ALLOW_ORIGINS || 'https://enceladus.spaceoceancorp.com,https://enceladus-globe.vercel.app')
  .split(',').map(s => s.trim()).filter(Boolean);
const TICK_MS = 100;            // send peer lists 10 times a second
const MAX_PEERS_SENT = 60;      // each client gets at most this many (the nearest)
const IDLE_MS = 20000;          // drop clients that send nothing for this long
const MAX_MSG_BYTES = 1024;
const RATE = { perSec: 30, burst: 60 };   // messages per second allowed per client
const R_ENC = 252100;           // reference sphere radius (m) that heights are measured from
const MODES = new Set(['ship', 'walk', 'rover', 'skim', 'orbit']);
const CLIENTS = new Set(['web', 'ue5', 'other']);

const originOk = o => !o || ALLOW.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o);
const num = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null);
const cleanName = s => (typeof s === 'string' ? s.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 24) : '') || null;

const players = new Map();      // id -> { ws, name, client, state, seen, tokens, last }
const server = http.createServer((req, res) => {
  // a plain web page answer, handy for "is it up?" checks; never lists who is on
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`Enceladus shared-world relay. ${players.size} connected. Protocol v1 (see PROTOCOL.md).\n`);
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  if (!originOk(req.headers.origin)) { ws.close(1008, 'origin not allowed'); return; }
  if (players.size >= MAX_CLIENTS) { ws.close(1013, 'full, try again later'); return; }
  const id = crypto.randomBytes(4).toString('hex');
  const p = { ws, id, name: `Pilot ${id.slice(0, 4).toUpperCase()}`, client: 'other', state: null, seen: Date.now(), tokens: RATE.burst, last: Date.now() };
  players.set(id, p);
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    p.tokens = Math.min(RATE.burst, p.tokens + (now - p.last) / 1000 * RATE.perSec); p.last = now;
    if (p.tokens < 1) return;                 // over the rate limit: ignore
    p.tokens -= 1;
    if (isBinary) return;
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    p.seen = now;
    if (m.type === 'hello') {
      p.name = cleanName(m.name) || p.name;
      p.client = CLIENTS.has(m.client) ? m.client : 'other';
      ws.send(JSON.stringify({ type: 'welcome', v: 1, id, name: p.name, tickMs: TICK_MS }));
    } else if (m.type === 'state') {
      const lat = num(m.lat, -90, 90), lon = num(m.lon, -180, 180), h = num(m.h, -50000, 2000000);
      if (lat === null || lon === null || h === null) return;
      p.state = { lat, lon, h, hd: num(m.hd, -360, 360) ?? 0, pt: num(m.pt, -90, 90) ?? 0, rl: num(m.rl, -180, 180) ?? 0,
        spd: num(m.spd, 0, 1e5) ?? 0, mode: MODES.has(m.mode) ? m.mode : 'ship' };
    } else if (m.type === 'name') {
      p.name = cleanName(m.name) || p.name;
    }
  });
  ws.on('close', () => { players.delete(id); broadcast({ type: 'left', id }); });
  ws.on('error', () => {});
});

function broadcast(msg) { const s = JSON.stringify(msg); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); }

// straight-line distance between two players (m), for picking the nearest
function xyz(s) {
  const r = R_ENC + s.h, la = s.lat * Math.PI / 180, lo = s.lon * Math.PI / 180;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
}

setInterval(() => {
  const now = Date.now(), live = [];
  for (const p of players.values()) {
    if (now - p.seen > IDLE_MS) { p.ws.close(1000, 'idle'); continue; }
    if (p.state) live.push({ p, x: xyz(p.state) });
  }
  for (const me of players.values()) {
    if (me.ws.readyState !== 1) continue;
    const mine = me.state && xyz(me.state);
    let list = live.filter(o => o.p !== me);
    if (mine && list.length > MAX_PEERS_SENT) {
      const d2 = o => (o.x[0] - mine[0]) ** 2 + (o.x[1] - mine[1]) ** 2 + (o.x[2] - mine[2]) ** 2;
      list = list.sort((a, b) => d2(a) - d2(b)).slice(0, MAX_PEERS_SENT);
    } else list = list.slice(0, MAX_PEERS_SENT);
    me.ws.send(JSON.stringify({ type: 'peers', t: now, online: players.size,
      peers: list.map(({ p }) => ({ id: p.id, name: p.name, client: p.client, ...p.state })) }));
  }
}, TICK_MS);

server.listen(PORT, () => console.log(`Enceladus relay listening on :${PORT} (origins: ${ALLOW.join(', ')} + localhost)`));
