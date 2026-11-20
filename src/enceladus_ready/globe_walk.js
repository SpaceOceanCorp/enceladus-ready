// ---------- surface: land anywhere, then walk, drive or skim across the ice ----------
// Real numbers: surface gravity 0.113 m/s2 (about 1/87 of Earth's), so an easy 2 m/s hop rises about 18 m and
// lasts about 35 s. Enceladus keeps one face to Saturn, so Saturn hangs still in the sky over 0 degrees longitude,
// 238,000 km away and nearly 28 degrees across, its rings almost edge-on because Enceladus orbits in the ring plane.
// SATURN_R is the equatorial radius at the 1-bar level (60,268 km); the poles are 0.902 of it (54,364 km).
const G_ENC = 0.113, SATURN_D = 238042e3, SATURN_R = 60268e3;
const walk = {
  on: false, picking: false, landing: 0, lat: 0, lon: 0, head: 0, pitch: 0.08, z: 0, vz: 0, ground: null,
  mode: 'walk', keys: new Set(), last: 0, savedEx: null, look: null, fast: false,
  SPEED: { walk: 3, rover: 25, skim: 400 }, EYE: { walk: 1.7, rover: 2.6, skim: 60 },
  // ship = true when started from Fly: same spot picking, but you start in your ship
  begin(ship = false) {
    this.picking = true; this.pickShip = !!ship;
    $('landhinttext').textContent = ship ? 'Click anywhere on the moon to start your ship there, or' : 'Click anywhere on the moon to land there, or';
    $('landStripes').textContent = ship ? 'Start at the Tiger Stripes' : 'Land at the tiger stripes';
    $('startSpace').style.display = ship ? '' : 'none';
    $('landhint').classList.add('open'); $(ship ? 'chipFly' : 'chipLand').classList.add('on');
  },
  cancel() { this.picking = false; this.pickShip = false; $('landhint').classList.remove('open'); if (!this.on) { $('chipLand').classList.remove('on'); $('chipFly').classList.remove('on'); } },
  pick(pos) {
    const ray = camera.getPickRay(pos); const p = ray && (globe.pick(ray, scene) || camera.pickEllipsoid(pos, E)); if (!p) return;
    const c = E.cartesianToCartographic(p); this.land(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude));
  },
  land(latDeg, lonDeg) {
    const toShip = this.pickShip;
    if (ship.on || ship.parked) ship.hide();
    this.cancel(); if (inside.on) inside.close(); if (dive.picking) dive.cancel();
    camera.cancelFlight(); drag.mode = null;
    this.lat = latDeg * Math.PI / 180; this.lon = lonDeg * Math.PI / 180; this.z = 0; this.vz = 0; this.ground = null;
    if (!this.on) { this.savedEx = scene.verticalExaggeration; scene.verticalExaggeration = 1; updateHeights(); exag.disabled = true; $('exagv').textContent = '1×'; }
    this.on = true; ssc.enableInputs = false;
    if (this.saturnUp()) this.faceSaturn(); else { this.head = 0; this.pitch = 0.05; }
    this.landing = performance.now();
    sky(true); document.body.classList.add('walking'); $('walkhud').classList.remove('hide'); this.hud();
    if (toShip) { this.landing = -1e9; ship.board(true); }   // Fly: no drop-in, you start in the ship hovering above the ice
    mp.ask();   // first time this visit: an optional call sign for the shared world
  },
  // sine of Saturn's height above the local horizon (Saturn sits over latitude 0, longitude 0)
  saturnDir() { return Math.cos(this.lat) * Math.cos(this.lon); },
  saturnUp() { return this.saturnDir() > -0.12; },
  faceSaturn() {
    this.head = Math.atan2(Math.sin(-this.lon), -Math.sin(this.lat) * Math.cos(-this.lon));
    this.pitch = Math.max(0.05, Math.asin(Math.max(-1, Math.min(1, this.saturnDir()))) - 0.05);
  },
  exit() {
    if (!this.on) return;
    if (ship.on || ship.parked) ship.hide();
    this.on = false; ssc.enableInputs = true; this.keys.clear(); this.look = null;
    scene.verticalExaggeration = this.savedEx || 4; exag.disabled = false; $('exagv').textContent = exag.value + '×'; updateHeights();
    sky(false); document.body.classList.remove('walking', 'flying'); $('walkhud').classList.add('hide'); $('chipLand').classList.remove('on'); $('chipFly').classList.remove('on');
    camera.setView({ destination: C.Cartesian3.fromRadians(this.lon, this.lat, 300e3, E), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  },
  frame(now) {
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000); this.last = now;
    const k = this.keys, m = this.mode;
    // the call sign card never holds anyone up: the first touch of any control (keys, the on-screen pad, a controller's
    // sticks) closes it, keeping whatever was typed, or nothing (an anonymous "Pilot 1234")
    if (mp.asking() && (k.size || ship.ax.pitch || ship.ax.yaw || ship.ax.roll)) mp.closeAsk(!!$('callsign').value.trim());
    if (m === 'ship') {
      ship.step(dt);
      try { ringField.update(dt); } catch (err) { console.error(err); }   // ring particles move with the very same time step as the ship
      ship.camera(); ship.fhud(); placeSky();
      if (!this._h || now - this._h > 250) { this._h = now; this.hud(); }
      return;
    }
    const f = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const s = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
    const t = (k.has('arrowright') || k.has('e') ? 1 : 0) - (k.has('arrowleft') || k.has('q') ? 1 : 0);
    this.head += t * 1.1 * dt;
    const g = globe.getHeight(C.Cartographic.fromRadians(this.lon, this.lat));
    if (g !== undefined) this.ground = this.ground === null ? g : this.ground + (g - this.ground) * Math.min(1, dt * 8);
    const ground = this.ground === null ? 0 : this.ground, Rl = R + ground, d = this.SPEED[m] * (k.has('shift') || this.fast ? 4 : 1) * dt;
    if (f || s) {
      const dn = d * (f * Math.cos(this.head) - s * Math.sin(this.head)), de = d * (f * Math.sin(this.head) + s * Math.cos(this.head));
      this.lat = Math.max(-1.5706, Math.min(1.5706, this.lat + dn / Rl));
      this.lon += de / (Rl * Math.max(0.01, Math.cos(this.lat)));
      if (this.lon > Math.PI) this.lon -= 2 * Math.PI;
      if (this.lon < -Math.PI) this.lon += 2 * Math.PI;
    }
    if (m === 'skim') { this.z = 0; this.vz = 0; }
    else if (this.z > 0 || this.vz > 0) { this.vz -= G_ENC * dt; this.z += this.vz * dt; if (this.z <= 0) { this.z = 0; this.vz = 0; } }
    // touch-down: ease in from 1.5 km over 3 seconds
    const L = Math.max(0, 1 - (now - this.landing) / 3000), drop = 1500 * L * L;
    camera.setView({ destination: C.Cartesian3.fromRadians(this.lon, this.lat, ground + this.EYE[m] + this.z + drop, E),
      orientation: { heading: this.head, pitch: this.pitch - 0.9 * L, roll: 0 } });
    placeSky();
    if (!this._h || now - this._h > 250) { this._h = now; this.hud(); }
  },
  hud() {
    const inShip = this.mode === 'ship';
    $('walkhud').classList.toggle('ship', inShip);
    $('chipFly').classList.toggle('on', this.on && inShip); $('chipLand').classList.toggle('on', this.on && !inShip);
    $('shippad').classList.toggle('hide', !(this.on && inShip));
    document.body.classList.toggle('flying', this.on && inShip);   // phones: the compact flight layout
    if (inShip) { ship.hud(); return; }
    $('walktitle').textContent = 'On the surface of Enceladus';
    $('walkShip').textContent = ship.parked ? 'Back to the ship' : 'Ship';
    const la = this.lat * 180 / Math.PI, lo = this.lon * 180 / Math.PI;
    $('walkpos').textContent = `${Math.abs(la).toFixed(3)}°${la >= 0 ? 'N' : 'S'}, ${Math.abs(lo).toFixed(3)}°${lo >= 0 ? 'E' : 'W'}`;
    $('walkelev').textContent = this.ground === null ? 'loading the ground…' : `${(this.ground / 1000).toFixed(2)} km vs. mean radius`;
    $('walkhop').textContent = this.mode === 'skim' ? `skimming ${this.EYE.skim} m up` : this.z > 0.5 ? `${this.z.toFixed(1)} m up, ${this.vz >= 0 ? 'rising' : 'falling'} at ${Math.abs(this.vz).toFixed(2)} m/s` : 'standing on the ice';
    $('walksat').textContent = this.saturnUp() ? 'Saturn is in your sky' : 'Saturn is below the horizon (this is the far side)';
    $('walkmp').textContent = mp.summary();
    document.querySelectorAll('#walkhud [data-mode]').forEach(b => b.classList.toggle('go', b.dataset.mode === this.mode));
    $('walkFast').classList.toggle('go', this.fast); $('walkFast').setAttribute('aria-pressed', this.fast);
  },
  jump() { if (this.on && this.mode !== 'skim' && this.z === 0) { this.vz = this.mode === 'rover' ? 1.2 : 2; this.z = 0.001; } },
};
// the sky while you are on the surface: stars, Saturn and its rings, and the plumes over the tiger stripes
let skyObjs = null;
// A soft round white glow as a PNG built by hand: every pixel is white and only the alpha fades, so the grains have no
// dark rims (a canvas stores clear pixels as black) and no square edges.
function puffPng(N = 64) {
  const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const chunk = (t, d) => { const td = [...t].map(ch => ch.charCodeAt(0)).concat(d); return u32(d.length).concat(td, u32(crc(td))); };
  const raw = [];
  for (let y = 0; y < N; y++) {
    raw.push(0);
    for (let x = 0; x < N; x++) { const r = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) / (N / 2); raw.push(255, 255, 255, r >= 1 ? 0 : Math.round(255 * Math.pow(1 - r, 1.8))); }
  }
  const z = [0x78, 0x01];      // zlib, stored (uncompressed) blocks
  for (let i = 0; i < raw.length; i += 65535) {
    const n = Math.min(65535, raw.length - i);
    z.push(i + n >= raw.length ? 1 : 0, n & 255, (n >> 8) & 255, ~n & 255, (~n >> 8) & 255);
    for (let j = 0; j < n; j++) z.push(raw[i + j]);
  }
  let a = 1, b = 0; for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const png = [137, 80, 78, 71, 13, 10, 26, 10].concat(chunk('IHDR', u32(N).concat(u32(N), [8, 6, 0, 0, 0])), chunk('IDAT', z.concat(u32(((b << 16) | a) >>> 0))), chunk('IEND', []));
  let s = ''; for (const x of png) s += String.fromCharCode(x);
  return 'data:image/png;base64,' + btoa(s);
}
// How hazy a direction is from inside a ring: the optical depth of ring on that side of you (tauUp above, tauDown below)
// over the sine of the angle to the ring plane, so the haze is thick along the plane and thin straight up or down.
// Shared by the ring picture here and the haze shell in globe_rings.js.
const RING_HAZE_GLSL = 'float ringHaze(vec3 dirEC, vec3 nEC, float up, float down) { float s = dot(dirEC, nEC); float t = s > 0.0 ? up : down;'
  + ' return 1.0 - exp(-t / max(abs(s), 0.03)); }\n';
function sky(on) {
  if (scene.skyBox) scene.skyBox.show = on;
  if (on && !skyObjs) {
    const M = C.Matrix4.fromTranslation(new C.Cartesian3(SATURN_D, 0, 0));
    const planet = scene.primitives.add(new C.Primitive({ modelMatrix: M, asynchronous: false, cull: false,
      geometryInstances: new C.GeometryInstance({ geometry: new C.EllipsoidGeometry({ radii: new C.Cartesian3(SATURN_R, SATURN_R, SATURN_R * 0.902),
        vertexFormat: C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat, slicePartitions: 96, stackPartitions: 48 }) }),
      appearance: new C.MaterialAppearance({ material: C.Material.fromType('Image', { image: 'saturn.jpg' }), flat: true, materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED }) }));
    const r0 = 74500e3, r1 = 140220e3, NS = 256, pos = [], st = [], idx = [];
    for (let i = 0; i <= NS; i++) {
      const a = i / NS * 2 * Math.PI;
      pos.push(r0 * Math.cos(a), r0 * Math.sin(a), 0, r1 * Math.cos(a), r1 * Math.sin(a), 0); st.push(0, 0.5, 1, 0.5);
      if (i < NS) { const q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    const rings = scene.primitives.add(new C.Primitive({ modelMatrix: M, asynchronous: false, cull: false,
      geometryInstances: new C.GeometryInstance({ geometry: new C.Geometry({ attributes: {
        position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(pos) }),
        st: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array(st) }) },
        indices: new Uint16Array(idx), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, r1) }) }),
      // the ring picture, with a hole around the eye (holeR, in the sky's 1/SKY_K units) where globe_rings.js draws the real
      // particles, and hazed by the ring around you when you are inside the layer (tauUp/tauDown, set by globe_rings.js)
      appearance: new C.MaterialAppearance({ material: new C.Material({ translucent: true, fabric: { type: 'RingImage',
        uniforms: { image: 'saturn-ring.png', holeR: 0, tauUp: 0, tauDown: 0, normalEC: new C.Cartesian3(0, 0, 1), hazeColor: new C.Color(0.5, 0.5, 0.5, 1) },
        source: RING_HAZE_GLSL + 'czm_material czm_getMaterial(czm_materialInput mi) { czm_material m = czm_getDefaultMaterial(mi); vec4 c = texture(image, mi.st);'
          + ' float k = holeR > 0.0 ? smoothstep(holeR * 0.6, holeR, length(mi.positionToEyeEC)) : 1.0;'
          + ' float h = ringHaze(normalize(-mi.positionToEyeEC), normalize(normalEC), tauUp, tauDown);'
          + ' m.diffuse = mix(c.rgb, hazeColor.rgb, h); m.alpha = c.a * k; return m; }' } }), translucent: true, flat: true,
        faceForward: true, closed: false, materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED }) }));
    // plumes: each mapped jet source (Porco et al. 2014) sprays a widening, flickering spray of ice grains, leaning by
    // its measured tilt from vertical, brighter where the jet was seen more often. Which way each one leans isn't in the
    // data, so that is a fixed random pick per jet. The grains are sped up to be watchable: here they rise 150 km in
    // about 20 s; real ones leave the vents at a few hundred m/s and take several minutes.
    const plumes = scene.primitives.add(new C.BillboardCollection({ scene, blendOption: C.BlendOption.TRANSLUCENT }));
    plumes._grains = [];
    const puffUrl = puffPng();   // one shared soft glow for every grain (a texture per grain would never finish loading)
    let seed = 20140601; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const V = C.Cartesian3;
    for (const j of jets || []) {
      const base = V.fromDegrees(j.lon, j.lat, 0, E), m = C.Transforms.eastNorthUpToFixedFrame(base, E);
      const e = new V(m[0], m[1], m[2]), n = new V(m[4], m[5], m[6]), u = new V(m[8], m[9], m[10]);
      const az = rnd() * 2 * Math.PI, tl = (j.tilt || 0) * Math.PI / 180;
      const lean = V.add(V.multiplyByScalar(e, Math.cos(az), new V()), V.multiplyByScalar(n, Math.sin(az), new V()), new V());
      const axis = V.normalize(V.add(V.multiplyByScalar(u, Math.cos(tl), new V()), V.multiplyByScalar(lean, Math.sin(tl), new V()), new V()), new V());
      const bright = 0.32 + 0.5 * (j.sightings || 0.2);
      for (let k = 0; k < 48; k++) {
        const b = rnd() * 2 * Math.PI, side = V.add(V.multiplyByScalar(e, Math.cos(b), new V()), V.multiplyByScalar(n, Math.sin(b), new V()), new V());
        const dir = V.normalize(V.add(axis, V.multiplyByScalar(side, Math.tan(rnd() * 0.24), new V()), new V()), new V());
        const col = new C.Color(0.78 + 0.2 * rnd(), 0.88 + 0.1 * rnd(), 1, 0);
        plumes._grains.push({ base, dir, side: V.normalize(V.cross(dir, side, new V()), new V()), ph: rnd(), sp: 0.65 + 0.7 * rnd(), w: rnd() * 6.283, bright, col,
          bb: plumes.add({ position: base, image: puffUrl, color: col, sizeInMeters: true, width: 800, height: 800 }) });
      }
    }
    skyObjs = { planet, rings, plumes };
  }
  if (skyObjs) for (const o of Object.values(skyObjs)) o.show = on;
  if (on) placeSky();
}
// Saturn at its true 238,000 km pushed the depth range out to ~380,000 km while the ground is 1.7 m away. Cesium
// then splits the view into two depth slices, and the split comes and goes as the nearest terrain tile changes,
// so Saturn blinked. Instead, each frame draw Saturn and its rings SKY_K times closer and SKY_K times smaller along
// the same line of sight: identical on screen, still far beyond any part of the moon (~2,400 km vs. a 504 km moon),
// and the whole scene fits in one depth slice.
const SKY_K = 100, _skyAt = new C.Cartesian3(), _skyM = new C.Matrix4();
function placeSky() {
  if (!skyObjs || !skyObjs.planet.show) return;
  const cam = camera.positionWC;
  _skyAt.x = cam.x + (SATURN_D - cam.x) / SKY_K; _skyAt.y = cam.y * (1 - 1 / SKY_K); _skyAt.z = cam.z * (1 - 1 / SKY_K);
  C.Matrix4.fromTranslation(_skyAt, _skyM); C.Matrix4.multiplyByUniformScale(_skyM, 1 / SKY_K, _skyM);
  skyObjs.planet.modelMatrix = C.Matrix4.clone(_skyM, skyObjs.planet.modelMatrix);
  skyObjs.rings.modelMatrix = C.Matrix4.clone(_skyM, skyObjs.rings.modelMatrix);
  animPlumes(performance.now());
}
// each grain rises along its own slightly spread path, wobbling sideways more as it climbs, and fades out at the top
const PLUME_H = 150e3, PLUME_T = 20, _gp = new C.Cartesian3();
function animPlumes(now) {
  const pl = skyObjs && skyObjs.plumes; if (!pl || !pl.show || !pl._grains) return;
  const t = now / 1000 / PLUME_T;
  for (const g of pl._grains) {
    const s = (t * g.sp + g.ph) % 1, h = PLUME_H * s, wob = 0.06 * h * Math.sin(g.w + now / 900 * g.sp);
    _gp.x = g.base.x + g.dir.x * h + g.side.x * wob; _gp.y = g.base.y + g.dir.y * h + g.side.y * wob; _gp.z = g.base.z + g.dir.z * h + g.side.z * wob;
    g.bb.position = _gp;
    g.col.alpha = g.bright * Math.pow(1 - s, 1.2) * Math.min(1, s * 30);
    const w = 800 + 14000 * s;      // each puff spreads as it climbs: ~1 km wide at the vent, ~15 km near the top
    g.bb.color = g.col; g.bb.width = w; g.bb.height = w;
  }
}
// The frame clock: the browser's animation time ticks exactly once per displayed frame, so motion advances in even
// steps. Reading performance.now() inside the render instead gave steps of 7 to 21 ms at a steady 60 fps, which
// made everything moving judder (most visibly far out in orbit space and among the ring particles).
const frameNow = () => { const t = document.timeline && document.timeline.currentTime; return typeof t === 'number' ? t : performance.now(); };
scene.preRender.addEventListener(() => { if (walk.on && !window.encPipPass) walk.frame(frameNow()); });   // not during a ship-camera pass
window.addEventListener('keydown', e => {
  if (!walk.on || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { walk.exit(); return; }
  if (walk.mode === 'ship') {
    if (k === 'v' && !e.repeat) { $('shipView').click(); return; }
    if (k === 'p' && !e.repeat) { $('shipAuto').click(); return; }
    if (k === 'h' && !e.repeat) { ship.toggleClean(); return; }
    const camKey = { 1: 'down', 2: 'rear', 3: 'left', 4: 'right' }[k];
    if (camKey && !e.repeat) { ship.pip.toggle(camKey); return; }
    if (['r', 'f', 'j', 'c', 'x', ' '].includes(k)) { e.preventDefault(); walk.keys.add(k); return; }
  }
  if (k === ' ') { e.preventDefault(); walk.jump(); return; }
  if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { e.preventDefault(); walk.keys.add(k); }
});
window.addEventListener('keyup', e => walk.keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => walk.keys.clear());
// drag to look around
// one finger (or the mouse) looks around; a second finger is ignored so the view doesn't jump
cv.addEventListener('pointerdown', e => { if (!walk.on || walk.look) return; walk.look = { x: e.clientX, y: e.clientY, id: e.pointerId }; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointermove', e => {
  if (!walk.on || !walk.look || e.pointerId !== walk.look.id) return;
  const dx = e.clientX - walk.look.x, dy = e.clientY - walk.look.y; walk.look.x = e.clientX; walk.look.y = e.clientY;
  if (walk.mode === 'ship') { ship.look(dx, dy); return; }   // in the ship, dragging swings the camera around it
  walk.head += dx * 0.004; walk.pitch = Math.max(-1.4, Math.min(1.4, walk.pitch - dy * 0.004));
});
const endLook = e => { if (walk.look && e.pointerId === walk.look.id) walk.look = null; };
cv.addEventListener('pointerup', endLook); cv.addEventListener('pointercancel', endLook);
// controls
$('chipLand').onclick = () => (walk.on ? walk.exit() : walk.picking ? walk.cancel() : walk.begin());
$('landCancel').onclick = () => walk.cancel();
$('landStripes').onclick = () => walk.land(-81.5, -30);   // between Baghdad and Damascus sulci, under the plumes
$('landSaturn').onclick = () => walk.land(5, 0);          // Saturn almost straight overhead
$('walkExit').onclick = () => walk.exit();
$('walkJump').onclick = () => walk.jump();
$('walkSat').onclick = () => walk.faceSaturn();
$('walkFast').onclick = () => { walk.fast = !walk.fast; walk.hud(); };
document.querySelectorAll('#walkhud [data-mode]').forEach(b => { b.onclick = () => { walk.mode = b.dataset.mode; walk.hud(); }; });
document.querySelectorAll('#walkhud [data-k]').forEach(b => {
  const k = b.dataset.k, on = e => { e.preventDefault(); walk.keys.add(k); }, off = () => walk.keys.delete(k);
  b.addEventListener('contextmenu', e => e.preventDefault()); b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
});

