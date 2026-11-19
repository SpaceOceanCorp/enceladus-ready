// ---------- surface: land anywhere, then walk, drive or skim across the ice ----------
// Real numbers: surface gravity 0.113 m/s2 (about 1/87 of Earth's), so an easy 2 m/s hop rises about 18 m and
// lasts about 35 s. Enceladus keeps one face to Saturn, so Saturn hangs still in the sky over 0 degrees longitude,
// 238,000 km away and nearly 28 degrees across, its rings almost edge-on because Enceladus orbits in the ring plane.
const G_ENC = 0.113, SATURN_D = 238042e3, SATURN_R = 58232e3;
const walk = {
  on: false, picking: false, landing: 0, lat: 0, lon: 0, head: 0, pitch: 0.08, z: 0, vz: 0, ground: null,
  mode: 'walk', keys: new Set(), last: 0, savedEx: null, look: null, fast: false,
  SPEED: { walk: 3, rover: 25, skim: 400 }, EYE: { walk: 1.7, rover: 2.6, skim: 60 },
  begin() { this.picking = true; $('landhint').classList.add('open'); $('chipLand').classList.add('on'); },
  cancel() { this.picking = false; $('landhint').classList.remove('open'); if (!this.on) $('chipLand').classList.remove('on'); },
  pick(pos) {
    const ray = camera.getPickRay(pos); const p = ray && (globe.pick(ray, scene) || camera.pickEllipsoid(pos, E)); if (!p) return;
    const c = E.cartesianToCartographic(p); this.land(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude));
  },
  land(latDeg, lonDeg) {
    this.cancel(); if (inside.on) inside.close(); if (dive.picking) dive.cancel();
    camera.cancelFlight(); drag.mode = null;
    this.lat = latDeg * Math.PI / 180; this.lon = lonDeg * Math.PI / 180; this.z = 0; this.vz = 0; this.ground = null;
    if (!this.on) { this.savedEx = scene.verticalExaggeration; scene.verticalExaggeration = 1; updateHeights(); exag.disabled = true; $('exagv').textContent = '1×'; }
    this.on = true; ssc.enableInputs = false;
    if (this.saturnUp()) this.faceSaturn(); else { this.head = 0; this.pitch = 0.05; }
    this.landing = performance.now();
    sky(true); document.body.classList.add('walking'); $('walkhud').classList.remove('hide'); $('chipLand').classList.add('on'); this.hud();
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
    this.on = false; ssc.enableInputs = true; this.keys.clear(); this.look = null;
    scene.verticalExaggeration = this.savedEx || 4; exag.disabled = false; $('exagv').textContent = exag.value + '×'; updateHeights();
    sky(false); document.body.classList.remove('walking'); $('walkhud').classList.add('hide'); $('chipLand').classList.remove('on');
    camera.setView({ destination: C.Cartesian3.fromRadians(this.lon, this.lat, 300e3, E), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  },
  frame(now) {
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000); this.last = now;
    const k = this.keys, m = this.mode;
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
    if (!this._h || now - this._h > 250) { this._h = now; this.hud(); }
  },
  hud() {
    const la = this.lat * 180 / Math.PI, lo = this.lon * 180 / Math.PI;
    $('walkpos').textContent = `${Math.abs(la).toFixed(3)}°${la >= 0 ? 'N' : 'S'}, ${Math.abs(lo).toFixed(3)}°${lo >= 0 ? 'E' : 'W'}`;
    $('walkelev').textContent = this.ground === null ? 'loading the ground…' : `${(this.ground / 1000).toFixed(2)} km vs. mean radius`;
    $('walkhop').textContent = this.mode === 'skim' ? `skimming ${this.EYE.skim} m up` : this.z > 0.5 ? `${this.z.toFixed(1)} m up, ${this.vz >= 0 ? 'rising' : 'falling'} at ${Math.abs(this.vz).toFixed(2)} m/s` : 'standing on the ice';
    $('walksat').textContent = this.saturnUp() ? 'Saturn is in your sky' : 'Saturn is below the horizon (this is the far side)';
    document.querySelectorAll('#walkhud [data-mode]').forEach(b => b.classList.toggle('go', b.dataset.mode === this.mode));
    $('walkFast').classList.toggle('go', this.fast); $('walkFast').setAttribute('aria-pressed', this.fast);
  },
  jump() { if (this.on && this.mode !== 'skim' && this.z === 0) { this.vz = this.mode === 'rover' ? 1.2 : 2; this.z = 0.001; } },
};
// the sky while you are on the surface: stars, Saturn and its rings, and the plumes over the tiger stripes
let skyObjs = null;
function sky(on) {
  if (scene.skyBox) scene.skyBox.show = on;
  if (on && !skyObjs) {
    const M = C.Matrix4.fromTranslation(new C.Cartesian3(SATURN_D, 0, 0));
    const planet = scene.primitives.add(new C.Primitive({ modelMatrix: M, asynchronous: false,
      geometryInstances: new C.GeometryInstance({ geometry: new C.EllipsoidGeometry({ radii: new C.Cartesian3(SATURN_R, SATURN_R, SATURN_R * 0.902),
        vertexFormat: C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat, slicePartitions: 96, stackPartitions: 48 }) }),
      appearance: new C.MaterialAppearance({ material: C.Material.fromType('Image', { image: 'saturn.jpg' }), flat: true, materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED }) }));
    const r0 = 74500e3, r1 = 140220e3, NS = 256, pos = [], st = [], idx = [];
    for (let i = 0; i <= NS; i++) {
      const a = i / NS * 2 * Math.PI;
      pos.push(r0 * Math.cos(a), r0 * Math.sin(a), 0, r1 * Math.cos(a), r1 * Math.sin(a), 0); st.push(0, 0.5, 1, 0.5);
      if (i < NS) { const q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    const rings = scene.primitives.add(new C.Primitive({ modelMatrix: M, asynchronous: false,
      geometryInstances: new C.GeometryInstance({ geometry: new C.Geometry({ attributes: {
        position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(pos) }),
        st: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array(st) }) },
        indices: new Uint16Array(idx), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, r1) }) }),
      appearance: new C.MaterialAppearance({ material: C.Material.fromType('Image', { image: 'saturn-ring.png', transparent: true }), translucent: true, flat: true,
        faceForward: true, closed: false, materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED }) }));
    // plumes: a faint glowing column over each mapped jet source (Porco et al. 2014), brighter where seen more often
    const plumes = scene.primitives.add(new C.PolylineCollection());
    for (const j of jets || []) {
      plumes.add({ positions: [C.Cartesian3.fromDegrees(j.lon, j.lat, 0, E), C.Cartesian3.fromDegrees(j.lon, j.lat, 150e3, E)], width: 10,
        material: C.Material.fromType('PolylineGlow', { color: new C.Color(0.75, 0.88, 1, 0.12 + 0.3 * (j.sightings || 0.2)), glowPower: 0.25 }) });
    }
    skyObjs = { planet, rings, plumes };
  }
  if (skyObjs) for (const o of Object.values(skyObjs)) o.show = on;
}
scene.preRender.addEventListener(() => { if (walk.on) walk.frame(performance.now()); });
window.addEventListener('keydown', e => {
  if (!walk.on || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { walk.exit(); return; }
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

