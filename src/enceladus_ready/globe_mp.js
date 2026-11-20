// ---------- shared world: see other people (web and the Unreal game) while you Land or Fly ----------
// Talks to the relay in enceladus-ready/multiplayer (protocol: multiplayer/PROTOCOL.md). While you are on the surface or
// flying, it sends where you are five times a second and draws everyone else near you: their ship or walker, a name tag,
// and a dot on the Fly map. Nothing runs (and nothing is sent) while you are just looking at the globe from orbit.
// The relay address: MP_URL below once it is hosted. On a local copy (localhost) it uses ws://localhost:8790, and
// ?mp=ws://host:port overrides it, so a test relay can be tried without touching the live site.
const MP_URL = (() => {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const q = new URLSearchParams(location.search).get('mp');
  if (local && q && /^wss?:\/\//.test(q)) return q;
  return local ? 'ws://localhost:8790' : (window.ENC_MP_URL || '');
})();
const MP_COLORS = ['#7fd1ff', '#ffd36b', '#9cff8a', '#ff9ad5', '#c3a6ff', '#ffb27a', '#7fffd9', '#ff8a8a'];
const mp = {
  ws: null, id: null, peers: new Map(), online: 0, status: MP_URL ? 'off' : 'none', lastSend: 0, retryAt: 0, retryMs: 2000, labels: null,
  saved: (() => { try { return localStorage.getItem('enc-mp-name') || ''; } catch (_) { return ''; } })(),
  anon: `Pilot ${Math.floor(1000 + Math.random() * 9000)}`,   // the name for anyone who leaves their call sign blank
  get name() { return this.saved || this.anon; },
  connect() {
    if (!MP_URL || this.ws) return;
    this.status = 'connecting';
    let ws; try { ws = new WebSocket(MP_URL); } catch (_) { this.fail(); return; }
    this.ws = ws;
    ws.onopen = () => { this.status = 'on'; this.retryMs = 2000; ws.send(JSON.stringify({ type: 'hello', v: 1, name: this.name, client: 'web' })); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } this.receive(m); };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.fail(); } };
    ws.onerror = () => {};
  },
  fail() { this.status = 'retry'; this.retryAt = performance.now() + this.retryMs; this.retryMs = Math.min(30000, this.retryMs * 2); this.clear(); },
  close() { if (this.ws) { const ws = this.ws; this.ws = null; try { ws.close(); } catch (_) {} } this.status = MP_URL ? 'off' : 'none'; this.clear(); },
  clear() { for (const o of this.peers.values()) this.drop(o); this.peers.clear(); this.online = 0; },
  receive(m) {
    const now = performance.now();
    if (m.type === 'welcome') { this.id = m.id; }
    else if (m.type === 'left') { const o = this.peers.get(m.id); if (o) { this.drop(o); this.peers.delete(m.id); } }
    else if (m.type === 'peers' && Array.isArray(m.peers)) {
      this.online = m.online || 0;
      const seen = new Set();
      for (const s of m.peers) {
        if (!s || typeof s.id !== 'string' || s.id === this.id) continue;
        seen.add(s.id);
        let o = this.peers.get(s.id);
        if (!o) { o = { id: s.id, css: MP_COLORS[parseInt(s.id.slice(0, 6), 16) % MP_COLORS.length] }; this.peers.set(s.id, o); }
        o.name = String(s.name || 'Pilot').slice(0, 24); o.client = s.client;
        o.prev = o.cur || s; o.tPrev = o.tCur || now; o.cur = s; o.tCur = now;
      }
      for (const [id, o] of this.peers) if (!seen.has(id)) { this.drop(o); this.peers.delete(id); }   // out of range or gone
    }
  },
  // where I am, in the shared format
  myState() {
    if (walk.mode === 'ship' && ship.on && !ship.settling) {
      const c = E.cartesianToCartographic(ship.p), [hd, pt, rl] = ship.hpr();
      return { lat: c.latitude / D2R_F, lon: c.longitude / D2R_F, h: c.height, hd, pt, rl, spd: C.Cartesian3.magnitude(ship.v), mode: 'ship' };
    }
    if (walk.mode === 'ship') return null;
    const h = (walk.ground ?? 0) + (walk.mode === 'skim' ? walk.EYE.skim : 0) + (walk.z || 0);
    return { lat: walk.lat / D2R_F, lon: walk.lon / D2R_F, h, hd: walk.head / D2R_F, pt: 0, rl: 0, spd: 0, mode: walk.mode };
  },
  // every frame: connect while on the surface, send 10 times a second, move everyone else
  frame(now) {
    if (!MP_URL) return;
    if (!walk.on) { if (this.ws || this.peers.size) this.close(); return; }
    if (!this.ws && now >= this.retryAt) this.connect();
    if (this.ws && this.ws.readyState === 1 && now - this.lastSend > 200) {
      const s = this.myState();
      if (s) { this.lastSend = now; this.ws.send(JSON.stringify({ type: 'state', ...s })); }
    }
    for (const o of this.peers.values()) this.place(o, now);
  },
  // draw a player about 250 ms in the past, between their last two updates, so motion is smooth
  place(o, now) {
    if (!o.cur) return;
    const a = o.tCur > o.tPrev ? clamp((now - 250 - o.tPrev) / (o.tCur - o.tPrev), 0, 1) : 1;
    const P = o.prev, Q = o.cur, lerp = (x, y) => x + (y - x) * a, lerpDeg = (x, y) => x + ((((y - x) % 360) + 540) % 360 - 180) * a;
    const lat = lerp(P.lat, Q.lat), lon = lerpDeg(P.lon, Q.lon), h = lerp(P.h, Q.h);
    const walker = Q.mode === 'walk' || Q.mode === 'rover';
    const kind = walker ? 'walker' : 'ship';
    if (o.kind !== kind) { this.drop(o); o.kind = kind; o.prim = kind === 'ship' ? ship.build(o.css, '#ff7a1a', false).hull : this.walker(o.css); }
    if (!o.label) {
      if (!this.labels) this.labels = scene.primitives.add(new C.LabelCollection());
      o.label = this.labels.add({ text: o.name + (o.client === 'ue5' ? ' (game)' : ''), font: '600 14px Inter, sans-serif', fillColor: C.Color.WHITE,
        outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: C.VerticalOrigin.BOTTOM,
        pixelOffset: new C.Cartesian2(0, -18), scaleByDistance: new C.NearFarScalar(200, 1, 2e5, 0.7) });
    }
    const p = V3.fromDegrees(lon, lat, h, E);
    enuAt(p);
    const hd = lerpDeg(P.hd, Q.hd) * D2R_F, pt = walker ? 0 : lerp(P.pt, Q.pt) * D2R_F, rl = walker ? 0 : lerpDeg(P.rl, Q.rl) * D2R_F;
    const F0 = comb(new V3(), Math.sin(hd), _E, Math.cos(hd), _N), R0 = comb(new V3(), Math.cos(hd), _E, -Math.sin(hd), _N);
    const F = comb(new V3(), Math.cos(pt), F0, Math.sin(pt), _U), U1 = comb(new V3(), -Math.sin(pt), F0, Math.cos(pt), _U);
    const Rt = comb(new V3(), Math.cos(rl), R0, -Math.sin(rl), U1), T = comb(new V3(), Math.sin(rl), R0, Math.cos(rl), U1);
    const m = o.M || (o.M = new C.Matrix4());
    m[0] = F.x; m[1] = F.y; m[2] = F.z; m[3] = 0; m[4] = -Rt.x; m[5] = -Rt.y; m[6] = -Rt.z; m[7] = 0;
    m[8] = T.x; m[9] = T.y; m[10] = T.z; m[11] = 0; m[12] = p.x; m[13] = p.y; m[14] = p.z; m[15] = 1;
    // far away, a 16 m ship (or a 1.9 m walker) is smaller than a pixel: grow it with distance so it always shows
    // at least ~44 px long (walkers ~26 px tall) on screen. Up close it is life size.
    const fov = camera.frustum.fovy || 1, Hpx = scene.canvas.clientHeight || 600, dist = V3.distance(camera.positionWC, p);
    const s = Math.max(1, ((walker ? 26 : 44) * 2 * dist * Math.tan(fov / 2)) / ((walker ? 1.9 : 16) * Hpx));
    if (s > 1) for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m[i] *= s;
    o.prim.modelMatrix = C.Matrix4.clone(m, o.prim.modelMatrix);
    o.label.position = comb(new V3(), 1, p, (walker ? 2.4 : 3.5) * s, T);
  },
  // a person in a suit, about 1.9 m tall, standing at the origin
  walker(css) {
    const VF = C.PerInstanceColorAppearance.VERTEX_FORMAT;
    const inst = (geometry, col, x, y, z) => new C.GeometryInstance({ geometry, modelMatrix: C.Matrix4.fromTranslation(new V3(x, y, z)),
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(col)) } });
    const box = (x, y, z) => C.BoxGeometry.fromDimensions({ dimensions: new V3(x, y, z), vertexFormat: VF });
    const ell = (a, b, c) => new C.EllipsoidGeometry({ radii: new V3(a, b, c), vertexFormat: VF });
    return scene.primitives.add(new C.Primitive({ asynchronous: false, cull: false, appearance: new C.PerInstanceColorAppearance({ translucent: false }),
      geometryInstances: [inst(box(0.32, 0.5, 0.85), '#e9ecf1', 0, 0, 0.43), inst(new C.CylinderGeometry({ length: 0.75, topRadius: 0.3, bottomRadius: 0.27, vertexFormat: VF }), css, 0, 0, 1.22),
        inst(ell(0.24, 0.24, 0.26), '#f4f6f9', 0, 0, 1.78), inst(ell(0.1, 0.19, 0.13), '#16324f', 0.17, 0, 1.79), inst(box(0.26, 0.46, 0.62), '#3c424d', -0.32, 0, 1.2)] }));
  },
  drop(o) {
    if (o.prim) { scene.primitives.remove(o.prim); o.prim = null; o.kind = null; }
    if (o.label && this.labels) { this.labels.remove(o.label); o.label = null; }
  },
  // the "Online" line in the Land and Fly panels
  summary() {
    if (this.status === 'connecting') return 'connecting…';
    if (this.status === 'retry') return 'shared world unreachable, retrying';
    if (this.status !== 'on') return '';
    const others = Math.max(0, this.online - 1);
    let near = null, nd = Infinity;
    const me = this.myState();
    if (me) {
      const mp0 = V3.fromDegrees(me.lon, me.lat, me.h, E);
      for (const o of this.peers.values()) if (o.cur) { const d = V3.distance(mp0, V3.fromDegrees(o.cur.lon, o.cur.lat, o.cur.h, E)); if (d < nd) { nd = d; near = o; } }
    }
    return `${others ? `${others} other${others > 1 ? 's' : ''}` : 'just you so far'}${near ? ` · nearest ${near.name}, ${fmtD(nd)}` : ''} · you are ${this.name}`;
  },
  // a call sign (kept on this device for next time), or blank for an anonymous "Pilot 1234"
  setName(n) {
    this.saved = String(n || '').normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 24);
    try { if (this.saved) localStorage.setItem('enc-mp-name', this.saved); else localStorage.removeItem('enc-mp-name'); } catch (_) {}
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'name', name: this.name }));
    if (walk.on) walk.hud();
  },
  rename() { this.ask(true); },
  // the call sign card: shown the first time you Land or Fly on each visit (and when you tap your name)
  ask(again = false) {
    if (!MP_URL || (this.asked && !again)) return;
    this.asked = true;
    const card = $('callcard'), inp = $('callsign');
    inp.value = this.saved; inp.placeholder = this.anon;
    card.classList.add('open');
    if (!matchMedia('(hover: none), (pointer: coarse)').matches) setTimeout(() => inp.focus(), 50);   // no surprise keyboard on phones
  },
  asking() { return $('callcard').classList.contains('open'); },
  closeAsk(save) {
    if (save) this.setName($('callsign').value);
    $('callcard').classList.remove('open'); $('callsign').blur();
  },
};
$('callGo').onclick = () => mp.closeAsk(true);
// touching any flight control (gears included) closes the card too, keeping whatever was typed
$('shippad').addEventListener('pointerdown', () => { if (mp.asking()) mp.closeAsk(!!$('callsign').value.trim()); }, true);
$('callSkip').onclick = () => mp.closeAsk(false);
$('callsign').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') mp.closeAsk(true); if (e.key === 'Escape') mp.closeAsk(false); });
$('callsign').addEventListener('keyup', e => e.stopPropagation());
scene.preRender.addEventListener(() => mp.frame(performance.now()));
if (!MP_URL) $('walkhud').classList.add('nomp');
for (const id of ['shipmp', 'walkmp']) { $(id).onclick = () => mp.rename(); $(id).title = 'Click to change your name'; }
