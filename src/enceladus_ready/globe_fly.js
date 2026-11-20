// ---------- fly: an arcade-simple, very capable ship, from skimming the ice up to 1,500 km ----------
// Started like Land: pick a spot and you are hovering above it. You fly it like a game: the ship goes where its nose
// points, pitch up and down, turn, roll, loop. Let go of everything and it stops and holds its place by itself
// (flight assist). It also never hits the ice hard: it always slows in time and climbs over hills it is heading for.
// Gravity is real point-mass gravity (GM = 7.21e9 m3/s2, 0.113 m/s2 at the surface, about 1/87 of Earth's; orbit
// just above the ice is ~169 m/s, escape 239 m/s). The ship is made up and far beyond anything real: thrusters that
// push any way at 3 g (12 g on turbo), a propellant-sipping fusion drive (Isp 50,000 s) and a WARP mode at up to
// 20 km/s that uses no propellant at all. The moon's slow spin (once per 1.37 days) is ignored.
const GM_ENC = 7.211e9, G0 = 9.80665, D2R_F = Math.PI / 180;
const SHIP = { dry: 12000, prop: 20000, isp: 50000, leg: 2.25, maxAlt: 1500e3,
  modes: { normal: { v: 150, up: 30, a: 30 }, turbo: { v: 900, up: 250, a: 120 }, warp: { v: 20000, up: 2000, a: 4000 },
    intra: { v: 150000, up: 150000, a: 60000 } },
  pitch: 1.3, yaw: 1.4, roll: 3.2 };
// Leaving Enceladus: above 1,500 km you are in orbit space between Enceladus and Saturn. Out there the drives scale with
// the distance to the nearest body (Saturn's clouds or Enceladus), so they cover 180,000 km in seconds yet still slow
// down on their own as you close in. INTRASTELLAR is the drive for this crossing.
const SPACE_K = { normal: 0.02, turbo: 0.1, warp: 0.3, intra: 1.5 };
const SPACE_OUT = 1200e3, SAT_AREA = 160000e3, SAT_FAR = 3e9;
const SAT = new C.Cartesian3(SATURN_D, 0, 0), LIGHT = 299792458;
// Saturn is flattened (polar radius 0.902 of the equatorial): its cloud-top radius toward unit direction n, and your height above it
const satR = n => SATURN_R / Math.sqrt(1 - n.z * n.z + (n.z * n.z) / (0.902 * 0.902));
const _sa = new C.Cartesian3();
const satAlt = p => { const d = C.Cartesian3.subtract(p, SAT, _sa), r = C.Cartesian3.magnitude(d); return r - satR(C.Cartesian3.divideByScalar(d, r, d)); };
const J_HINT = matchMedia('(hover: none), (pointer: coarse)').matches ? 'tap INTRASTELLAR, then hold GO to cross.' : 'hold INTRASTELLAR (J) to cross.';
const MODE_NAME = { turbo: 'TURBO', warp: 'WARP', intra: 'INTRASTELLAR' };
// Fuels. The exhaust colour is roughly how each really burns; Isp (seconds) is its efficiency, which sets how fast the
// tank drains (WARP and INTRASTELLAR use none). Thrust is the same for every fuel, so the ship handles alike.
const FUELS = {
  fusion: { name: 'Fusion (D–He3)', isp: 50000, rgb: [1, 0.42, 0.86], a: 0.5 },
  hydrolox: { name: 'Hydrogen + oxygen', isp: 450, rgb: [0.72, 0.84, 1], a: 0.28 },
  methalox: { name: 'Methane + oxygen', isp: 370, rgb: [0.32, 0.48, 1], a: 0.5 },
  kerolox: { name: 'Kerosene + oxygen', isp: 340, rgb: [1, 0.58, 0.14], a: 0.6 },
  hydrazine: { name: 'Hydrazine', isp: 230, rgb: [1, 0.86, 0.48], a: 0.34 },
  xenon: { name: 'Xenon ion', isp: 3000, rgb: [0.42, 0.74, 1], a: 0.6 },
  coldgas: { name: 'Cold gas (nitrogen)', isp: 70, rgb: [0.92, 0.96, 1], a: 0.24 },
};
const loadPref = (k, d) => { try { const v = localStorage.getItem(k); return FUELS[v] ? v : d; } catch (_) { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
const FUEL_PLAY = 20;   // tanks drain 20x slower than the real Isp would, so chemical fuels still give a playable flight
const CRASH_VS = 8, CRASH_HS = 60;   // touching the ice faster than this (m/s down, or m/s along the ground) is a crash
const START_ALT = 150;   // Fly starts you hovering this many metres above the ice
const VIEWS = [{ name: 'Chase', d: 34 }, { name: 'Far', d: 400 }, { name: 'Cockpit', d: 0 }];
const V3 = C.Cartesian3, _enu = new C.Matrix4(), _carto = new C.Cartographic();
const _E = new V3(), _N = new V3(), _U = new V3(), _t1 = new V3(), _t2 = new V3(), _t3 = new V3(), _vt = new V3(), _a = new V3();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function enuAt(p) {
  C.Transforms.eastNorthUpToFixedFrame(p, E, _enu);
  V3.fromElements(_enu[0], _enu[1], _enu[2], _E); V3.fromElements(_enu[4], _enu[5], _enu[6], _N); V3.fromElements(_enu[8], _enu[9], _enu[10], _U);
}
function comb(out, a, va, b, vb, c, vc) {   // out = a*va + b*vb (+ c*vc)
  out.x = a * va.x + b * vb.x + (c ? c * vc.x : 0); out.y = a * va.y + b * vb.y + (c ? c * vc.y : 0); out.z = a * va.z + b * vb.z + (c ? c * vc.z : 0);
  return out;
}
// turn the pair of axes (a, b) by angle t, a toward b
function turnPair(a, b, t) { const c = Math.cos(t), s = Math.sin(t); const ax = a.x, ay = a.y, az = a.z;
  a.x = ax * c + b.x * s; a.y = ay * c + b.y * s; a.z = az * c + b.z * s;
  b.x = b.x * c - ax * s; b.y = b.y * c - ay * s; b.z = b.z * c - az * s; }
const fmtD = m => { const a = Math.abs(m), s = m < 0 ? '−' : ''; if (a >= 1e5) return `${s}${Math.round(a / 1000).toLocaleString('en-US')} km`; return a < 1000 ? `${s}${a.toFixed(a < 10 ? 1 : 0)} m` : `${s}${(a / 1000).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0)} km`; };
const fmtV = v => v >= 1e5 ? `${Math.round(v / 1000).toLocaleString('en-US')} km/s` : v < 1000 ? `${v.toFixed(0)} m/s` : `${(v / 1000).toFixed(v < 1e4 ? 2 : 1)} km/s`;
const groundAt = p => { const c = E.cartesianToCartographic(p); const g = c && globe.getHeight(c); return g === undefined || !c ? null : c.height - g; };

const ship = {
  on: false, parked: false, settling: false, startAlt: 0, p: new V3(), v: new V3(),
  f: new V3(1, 0, 0), r: new V3(0, -1, 0), u: new V3(0, 0, 1), rates: [0, 0, 0],   // body axes (forward, right, up) and pitch/yaw/roll rates
  fuel: SHIP.prop, view: 0, zoom: 1, camYaw: 0, camPitch: 0.16, landed: true, alt: 0, ground: null, mode: 'normal',
  space: false, inSat: false, dS: 0, dE: 0, crashed: false, crashT: 0, fireball: null,
  mainFuel: loadPref('encShipMain', 'fusion'), thrFuel: loadPref('encShipThr', 'hydrazine'),
  infinite: (() => { try { return localStorage.getItem('encShipInf') === '1'; } catch (_) { return false; } })(),
  isp() { return FUELS[this.mainFuel].isp * FUEL_PLAY; },
  setInfinite(on) {
    this.infinite = on; if (on) this.fuel = SHIP.prop;
    try { localStorage.setItem('encShipInf', on ? '1' : '0'); } catch (_) {}
    const b = $('fuelInf'); b.classList.toggle('go', on); b.setAttribute('aria-pressed', on); b.textContent = on ? 'Unlimited fuel: on' : 'Unlimited fuel: off';
    this.say(on ? 'Unlimited fuel: the tanks never run dry.' : 'Unlimited fuel off: the tanks drain again.');
  },
  ax: { pitch: 0, yaw: 0, roll: 0 },   // analog steering from a gamepad or flight stick, -1..1 (0 when none)
  fwdGlow: 0, upGlow: 0, msg: '', msgT: 0, prims: null, M: new C.Matrix4(),
  say(t) { this.msg = t; this.msgT = performance.now(); },
  // back to cruise: a new or reboarded ship never starts in a fast gear
  clearGear() { this.gear = null; document.querySelectorAll('#shippad .sel').forEach(b => b.classList.remove('sel')); },
  // heading, pitch, roll (degrees) in the local east-north-up frame, as the shared-world protocol uses
  hpr() { enuAt(this.p); return [Math.atan2(V3.dot(this.f, _E), V3.dot(this.f, _N)) / D2R_F, Math.asin(clamp(V3.dot(this.f, _U), -1, 1)) / D2R_F,
    Math.atan2(-V3.dot(this.r, _U), V3.dot(this.u, _U)) / D2R_F]; },
  heading() { enuAt(this.p); return Math.atan2(V3.dot(this.f, _E), V3.dot(this.f, _N)); },
  // face heading h, level, at the current spot
  level(h) { enuAt(this.p); comb(this.f, Math.sin(h), _E, Math.cos(h), _N); comb(this.r, Math.cos(h), _E, -Math.sin(h), _N); V3.clone(_U, this.u); },
  orthonormalize() {
    V3.normalize(this.f, this.f); V3.normalize(V3.cross(this.f, this.u, this.r), this.r); V3.cross(this.r, this.f, this.u);
  },
  // builds the ship's primitives (and returns them); other players' ships reuse it in their own colours, without flames
  build(HULL = '#e9ecf1', ORANGE = '#ff7a1a', flames = true) {
    const VF = C.PerInstanceColorAppearance.VERTEX_FORMAT, FVF = C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT;
    const inst = (geometry, css, m) => new C.GeometryInstance({ geometry, modelMatrix: m,
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(typeof css === 'string' ? C.Color.fromCssColorString(css) : css) } });
    const rot = (z = 0, y = 0, x = 0) => C.Matrix3.multiply(C.Matrix3.fromRotationZ(z), C.Matrix3.multiply(C.Matrix3.fromRotationY(y), C.Matrix3.fromRotationX(x), new C.Matrix3()), new C.Matrix3());
    const at = (x, y, z, m3 = C.Matrix3.IDENTITY) => C.Matrix4.fromRotationTranslation(m3, new V3(x, y, z));
    const cyl = (length, topRadius, bottomRadius, vf = VF) => new C.CylinderGeometry({ length, topRadius, bottomRadius, vertexFormat: vf, slices: 40 });
    const box = (x, y, z) => C.BoxGeometry.fromDimensions({ dimensions: new V3(x, y, z), vertexFormat: VF });
    const ell = (a, b, c) => new C.EllipsoidGeometry({ radii: new V3(a, b, c), vertexFormat: VF });
    const DARK = '#2a2f39', ENGINE = '#3c424d', NOZZLE = '#15181d', GLASS = '#0f3d63';
    const alongX = rot(0, Math.PI / 2);   // cylinders are built along z; this turns them to point forward
    const parts = [
      inst(ell(8, 2.4, 1.3), HULL, at(0, 0, 0)),                    // fuselage
      inst(ell(5, 1.25, 1.0), DARK, at(-1.2, 0, 0.85)),             // dorsal spine
      inst(ell(2.5, 1.15, 0.85), GLASS, at(3.3, 0, 0.95)),          // canopy
      inst(ell(1.2, 2.45, 0.35), ORANGE, at(5.2, 0, 0.15)),         // nose stripe
      inst(cyl(0.4, 0.9, 0.9), NOZZLE, at(0, 0, -1.25)),            // belly lift thruster
    ];
    for (const s of [1, -1]) {
      parts.push(
        inst(box(5.6, 6.8, 0.26), HULL, at(-2.4, s * 4.4, -0.2, rot(-s * 0.38))),     // swept wing
        inst(box(1.8, 0.35, 0.34), ORANGE, at(-4.3, s * 7.6, -0.2, rot(-s * 0.38))),  // wingtip
        inst(cyl(6, 1.0, 1.0), ENGINE, at(-3.6, s * 2.7, 0.15, alongX)),               // engine pod
        inst(cyl(0.9, 0.8, 1.08), NOZZLE, at(-7.0, s * 2.7, 0.15, alongX)),            // engine bell
        inst(cyl(0.5, 1.02, 1.02), ORANGE, at(-1.0, s * 2.7, 0.15, alongX)),           // pod band
        inst(box(2.8, 0.24, 2.3), DARK, at(-5.6, s * 1.5, 1.55, rot(0, 0, s * 0.3))),  // tail fin
        inst(box(6.2, 0.26, 0.26), DARK, at(0.2, s * 1.8, -2.1)),                      // landing skid
        inst(box(0.26, 0.26, 1.0), DARK, at(2.2, s * 1.8, -1.6)), inst(box(0.26, 0.26, 1.0), DARK, at(-1.8, s * 1.8, -1.6)));
    }
    const hull = scene.primitives.add(new C.Primitive({ geometryInstances: parts, appearance: new C.PerInstanceColorAppearance({ translucent: false }),
      asynchronous: false, cull: false }));
    if (!flames) return { hull };
    return Object.assign({ hull }, this.flames());
  },
  // the exhaust: unit-length cones, scaled each frame, coloured by the chosen fuels (rebuilt when a fuel changes).
  // Rear ones point back from x = 0, the belly one down from z = 0, the wingtip roll jets up or down from each tip.
  flames() {
    const FVF = C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT, alongX = C.Matrix3.fromRotationY(Math.PI / 2);
    const at = (x, y, z, m3 = C.Matrix3.IDENTITY) => C.Matrix4.fromRotationTranslation(m3, new V3(x, y, z));
    const cone = (top, bot) => new C.CylinderGeometry({ length: 1, topRadius: top, bottomRadius: bot, vertexFormat: FVF, slices: 24 });
    const col = (f, k = 1) => { const F = FUELS[f]; return new C.Color(F.rgb[0], F.rgb[1], F.rgb[2], Math.min(1, F.a * k)); };
    const core = f => { const F = FUELS[f]; return new C.Color(0.6 + 0.4 * F.rgb[0], 0.6 + 0.4 * F.rgb[1], 0.6 + 0.4 * F.rgb[2], Math.min(1, F.a * 1.4)); };
    const inst = (geometry, color, m) => new C.GeometryInstance({ geometry, modelMatrix: m, attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color) } });
    const glow = instances => scene.primitives.add(new C.Primitive({ geometryInstances: instances, asynchronous: false, cull: false,
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }) }));
    const M = this.mainFuel, T = this.thrFuel;
    const rear = glow([1, -1].flatMap(s => [inst(cone(0.62, 0.04), col(M), at(-0.5, s * 2.7, 0, alongX)),
      inst(cone(0.3, 0.02), core(M), at(-0.3, s * 2.7, 0, alongX))]));
    const warpGlow = glow([1, -1].map(s => inst(cone(0.75, 0.04), new C.Color(0.85, 0.55, 1, 0.5), at(-0.5, s * 2.7, 0, alongX))));
    const belly = glow(inst(cone(0.7, 0.06), col(T), at(0, 0, -0.5)));
    const tip = (y, dir) => glow(inst(cone(dir > 0 ? 0.04 : 0.35, dir > 0 ? 0.35 : 0.04), col(T, 1.6), at(0, y, dir * 0.5)));
    return { rear, warpGlow, belly, rcs_lu: tip(7.6, 1), rcs_ld: tip(7.6, -1), rcs_ru: tip(-7.6, 1), rcs_rd: tip(-7.6, -1) };   // y > 0: left wing
  },
  setFuel(kind, id) {
    if (!FUELS[id]) return;
    if (kind === 'main') this.mainFuel = id; else this.thrFuel = id;
    savePref(kind === 'main' ? 'encShipMain' : 'encShipThr', id);
    if (this.prims) {
      const keys = ['rear', 'warpGlow', 'belly', 'rcs_lu', 'rcs_ld', 'rcs_ru', 'rcs_rd'];
      for (const k of keys) if (this.prims[k]) scene.primitives.remove(this.prims[k]);
      Object.assign(this.prims, this.flames());
      for (const k of keys) this.prims[k].show = false;
      if (this.on && !this.crashed) this.place();
    }
    this.say(kind === 'main' ? `Main engines: ${FUELS[id].name} (Isp ${FUELS[id].isp.toLocaleString('en-US')} s).` : `Thrusters: ${FUELS[id].name}.`);
  },
  show(on) { if (this.prims) for (const p of Object.values(this.prims)) p.show = on; },
  place() {
    const m = this.M, p = this.p, f = this.f, r = this.r, u = this.u;
    m[0] = f.x; m[1] = f.y; m[2] = f.z; m[3] = 0; m[4] = -r.x; m[5] = -r.y; m[6] = -r.z; m[7] = 0;
    m[8] = u.x; m[9] = u.y; m[10] = u.z; m[11] = 0; m[12] = p.x; m[13] = p.y; m[14] = p.z; m[15] = 1;
    const { hull, rear, warpGlow, belly } = this.prims, flick = () => 0.9 + 0.2 * Math.random();
    hull.modelMatrix = C.Matrix4.clone(m, hull.modelMatrix);
    const warp = (this.mode === 'warp' || this.mode === 'intra') && this.fwdGlow > 0.3;
    const flame = warp ? warpGlow : rear; (warp ? rear : warpGlow).show = false;
    flame.show = this.fwdGlow > 0.02;
    if (flame.show) {
      const L = (1.5 + (this.mode === 'intra' ? 60 : warp ? 30 : 8) * this.fwdGlow) * flick(), loc = C.Matrix4.fromTranslation(new V3(-7.45, 0, 0.15));
      C.Matrix4.multiplyByScale(loc, new V3(L, 1, 1), loc);
      flame.modelMatrix = C.Matrix4.multiply(m, loc, flame.modelMatrix);
    }
    // wingtip roll jets: rolling right (right wing down) the right tip fires up and the left tip down; the reverse to the left
    const roll = this.rates[2], rl = Math.min(1, Math.abs(roll) / 1.2), jets = roll > 0 ? ['rcs_ru', 'rcs_ld'] : ['rcs_lu', 'rcs_rd'];
    for (const k of ['rcs_lu', 'rcs_ld', 'rcs_ru', 'rcs_rd']) {
      const pr = this.prims[k], on = rl > 0.08 && jets.includes(k); pr.show = on;
      if (on) { const loc = C.Matrix4.fromTranslation(new V3(-4.3, 0, -0.2)); C.Matrix4.multiplyByScale(loc, new V3(1, 1, (0.8 + 3.5 * rl) * flick()), loc); pr.modelMatrix = C.Matrix4.multiply(m, loc, pr.modelMatrix); }
    }
    belly.show = !this.landed && this.upGlow > 0;
    if (belly.show) {
      const L = (1.2 + 9 * this.upGlow) * flick(), loc = C.Matrix4.fromTranslation(new V3(0, 0, -1.45));
      C.Matrix4.multiplyByScale(loc, new V3(1, 1, L), loc);
      belly.modelMatrix = C.Matrix4.multiply(m, loc, belly.modelMatrix);
    }
  },
  // airborne: started from Fly, so begin hovering START_ALT above the ice; otherwise sit on the ice (or reboard a parked ship)
  board(airborne = false) {
    if (!walk.on || this.on) return;
    if (!this.prims) this.prims = this.build();
    const near = !airborne && this.parked && V3.distance(this.p, V3.fromRadians(walk.lon, walk.lat, (walk.ground || 0) + SHIP.leg, E, _t1)) < 300;
    if (!near) {
      this.p = V3.fromRadians(walk.lon, walk.lat, (walk.ground ?? 0) + SHIP.leg, E, this.p);
      this.level(walk.head); this.ground = null; this.settling = true;
    } else this.level(this.heading());
    this.startAlt = airborne ? START_ALT : 0; this.home = { lat: walk.lat, lon: walk.lon };
    if (airborne) { this.view = 0; this.zoom = 1; this.camPitch = 0.16; }
    this.rates = [0, 0, 0]; this.mode = 'normal'; this.space = false; this.inSat = false; this.crashed = false; this.clearGear();
    V3.clone(V3.ZERO, this.v); this.landed = !airborne; this.fwdGlow = 0; this.upGlow = 0;
    this.on = true; this.parked = false; this.camYaw = 0; walk.mode = 'ship'; walk.keys.clear();
    const touch = matchMedia('(hover: none), (pointer: coarse)').matches;
    this.say(touch ? 'The stick points the nose, GO flies. ROLL spins you over (fly upside down if you like). Tap TURBO, WARP or INTRASTELLAR to put GO in a faster gear. Hit the ice too hard and you crash.'
      : 'W go, S back, A/D turn, ↑/↓ nose, Q/E roll (fly upside down if you like). Hold Shift, F or J to go faster. Hit the ice too hard and you crash.');
    this.show(true); this.place(); walk.hud();
  },
  // step out onto the ice next to the ship; the ship stays parked where it is
  disembark() {
    if (!this.landed) { this.say('Land first: hold DOWN (or C) to set down on the ice.'); this.hud(); return; }
    const h = this.heading();
    const spot = E.cartesianToCartographic(comb(_t1, 1, this.p, 12, this.r));   // 12 m off the right side
    walk.lat = spot.latitude; walk.lon = spot.longitude; walk.head = h + Math.PI; walk.pitch = 0.05; walk.ground = null; walk.z = 0; walk.vz = 0;
    walk.mode = 'walk'; walk.keys.clear(); this.on = false; this.parked = true; this.fwdGlow = this.upGlow = 0;
    this.place(); walk.hud(); $('flighthud').classList.add('hide');
  },
  // leaving surface mode altogether
  hide() {
    if (this.on) { const c = E.cartesianToCartographic(this.p); walk.lat = c.latitude; walk.lon = c.longitude; }
    this.space = false; this.inSat = false;
    this.on = false; this.parked = false; this.show(false); if (walk.mode === 'ship') walk.mode = 'walk';
    $('shippad').classList.add('hide'); $('shipmap').classList.add('hide'); $('flighthud').classList.add('hide');
    if (this.fireball) this.fireball.show = false; this.crashed = false;
    this.ap = null; $('appanel').classList.add('hide');
  },
  // into the ice too fast: a fireball, then a fresh ship hovering over the same spot
  crash(speed, what = 'the ice') {
    this.crashed = true; this.crashT = performance.now(); this.show(false); walk.keys.clear(); this.ap = null; this.apUI();
    if (!this.fireball) this.fireball = scene.primitives.add(new C.Primitive({ asynchronous: false, cull: false,
      geometryInstances: new C.GeometryInstance({ id: 'fireball', geometry: new C.EllipsoidGeometry({ radii: new V3(1, 1, 1), vertexFormat: C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(new C.Color(1, 0.75, 0.2, 0.85)) } }),
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }) }));
    this.fireball.show = true;
    this.say(`CRASH! You hit ${what} at ${fmtV(speed)}. A new ship is on its way…`); this.hud();
  },
  crashStep() {
    const t = (performance.now() - this.crashT) / 1000, fb = this.fireball;
    if (fb) {
      fb.modelMatrix = C.Matrix4.multiplyByUniformScale(C.Matrix4.fromTranslation(this.p), 4 + 60 * Math.pow(Math.min(1, t / 1.2), 0.6), new C.Matrix4());
      fb.show = t < 1.6;
      try { const a = fb.getGeometryInstanceAttributes('fireball'); if (a) a.color = C.ColorGeometryInstanceAttribute.toValue(new C.Color(1, 0.5 + 0.35 * Math.max(0, 1 - t), 0.15, Math.max(0, 0.85 * (1 - t / 1.6)))); } catch (_) {}
    }
    if (t > 3) this.respawn();
  },
  respawn() {
    // over the crash site on Enceladus; after a crash into Saturn, back where this flight started
    const c = this.space ? null : E.cartesianToCartographic(this.p), lon = c ? c.longitude : this.home.lon, lat = c ? c.latitude : this.home.lat;
    this.crashed = false; this.space = false; this.inSat = false; if (this.fireball) this.fireball.show = false;
    this.p = V3.fromRadians(lon, lat, 0, E, this.p); const h = this.heading(); this.level(h);
    V3.clone(V3.ZERO, this.v); this.rates = [0, 0, 0]; this.fuel = SHIP.prop; this.clearGear();
    this.startAlt = START_ALT; this.ground = null; this.settling = true; this.landed = false; this.fwdGlow = this.upGlow = 0;
    this.show(true); this.place(); this.say('New ship, full tanks. Fly again!'); this.hud();
  },
  // jump straight to a spot (clicking the map): same height above the ice, stopped, level
  jumpTo(lat, lon) {
    const h = this.heading();
    this.p = V3.fromDegrees(lon, lat, 0, E, this.p); this.level(h);
    V3.clone(V3.ZERO, this.v); this.rates = [0, 0, 0];
    this.startAlt = Math.max(START_ALT, this.alt); this.ground = null; this.settling = true; this.landed = false;
    this.say(`Jumped to ${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}.`);
  },
  // Fly can also start out in orbit space: 40,000 km from Enceladus on the Saturn side, a little north of the ring
  // plane, stopped, nose on Saturn. (A crash from here sends the new ship to the spot under Saturn on Enceladus.)
  startInSpace() {
    V3.fromElements(40000e3, 0, 6000e3, this.p);
    V3.normalize(V3.subtract(SAT, this.p, this.f), this.f); V3.fromElements(0, 0, 1, this.u); this.orthonormalize();
    V3.clone(V3.ZERO, this.v); this.rates = [0, 0, 0]; this.settling = false; this.startAlt = 0; this.mode = 'normal';
    this.dS = satAlt(this.p); this.dE = V3.magnitude(this.p) - R;
    this.enterSpace();
    this.say('You start in orbit space, 40,000 km out from Enceladus. Saturn is dead ahead: ' + J_HINT);
    this.place(); this.hud();
  },
  // past 1,500 km: out into the space between Enceladus and Saturn
  enterSpace() {
    this.space = true; this.inSat = false; this.landed = false; this.settling = false;
    this.say('You have left Enceladus and are in orbit space. Point at Saturn and ' + J_HINT);
  },
  // flying in orbit space and the Saturn area: no ground, Saturn's pull left out (an arcade drive), speed set by distance
  stepSpace(dt) {
    const k = walk.keys, has = (...a) => a.some(x => k.has(x));
    const fwd = (has('w') || (!has('s') && has('shift', 'f', 'j')) ? 1 : 0) - (has('s') ? 1 : 0);
    const turn = ((has('d', 'arrowright') ? 1 : 0) - (has('a', 'arrowleft') ? 1 : 0)) || this.ax.yaw;   // keys, or a controller's stick
    const pitchIn = ((has('arrowup') ? 1 : 0) - (has('arrowdown') ? 1 : 0)) || this.ax.pitch;
    const rollIn = ((has('e') ? 1 : 0) - (has('q') ? 1 : 0)) || this.ax.roll;
    const up = has('r', ' '), down = has('c'), brake = has('x');
    this.mode = has('j') ? 'intra' : has('f') ? 'warp' : has('shift') ? 'turbo' : 'normal';
    const ease = Math.min(1, dt * 6), tgt = [pitchIn * SHIP.pitch, turn * SHIP.yaw, rollIn * SHIP.roll];
    for (let i = 0; i < 3; i++) this.rates[i] += (tgt[i] - this.rates[i]) * ease;
    turnPair(this.f, this.u, this.rates[0] * dt); turnPair(this.f, this.r, this.rates[1] * dt); turnPair(this.u, this.r, this.rates[2] * dt);
    this.orthonormalize();
    const toS = V3.subtract(this.p, SAT, _t3);
    this.dS = satAlt(this.p); this.dE = V3.magnitude(this.p) - R;
    const V = Math.min(LIGHT, SPACE_K[this.mode] * Math.max(20e3, Math.min(this.dS, this.dE)));   // nothing beats light
    comb(_vt, brake ? 0 : fwd > 0 ? V : fwd < 0 ? -0.4 * V : 0, this.f, brake ? 0 : up ? 0.5 * V : down ? -0.5 * V : 0, this.u);
    V3.multiplyByScalar(V3.subtract(_vt, this.v, _a), Math.min(1, dt * (brake ? 4 : 2)), _a);
    V3.add(this.v, _a, this.v);
    V3.add(this.p, V3.multiplyByScalar(this.v, dt, _t2), this.p);
    V3.subtract(this.p, SAT, toS);
    const rS = V3.magnitude(toS);
    // Saturn's cloud tops (it is flattened: 54,364 km to the poles): fly into them and that is the end of the ship
    if ((toS.x * toS.x + toS.y * toS.y) / (SATURN_R * SATURN_R) + (toS.z * toS.z) / Math.pow(SATURN_R * 0.902, 2) < 1) {
      this.crash(V3.magnitude(this.v), "Saturn's clouds"); return;
    }
    if (rS > SAT_FAR) {      // a far edge well past Titan: slide along it
      const n = V3.normalize(toS, _t1), vr = V3.dot(this.v, n);
      V3.add(SAT, V3.multiplyByScalar(n, SAT_FAR, _t2), this.p);
      if (vr > 0) V3.subtract(this.v, V3.multiplyByScalar(n, vr, _t2), this.v);
      if (performance.now() - this.msgT > 5000) this.say('Far enough: this is the edge of the Saturn system.');
    }
    this.dS = satAlt(this.p); this.dE = V3.magnitude(this.p) - R;
    const inSat = V3.distance(this.p, SAT) < SAT_AREA;
    if (inSat !== this.inSat) {
      this.inSat = inSat;
      this.say(inSat ? "Entering the Saturn area. The main rings span 74,500 to 140,220 km from Saturn's centre." : 'Leaving the Saturn area, back in orbit space.');
    }
    if (this.dE < SPACE_OUT) {      // back down to Enceladus: normal flight again, at no more than warp speed
      this.space = false; this.inSat = false; this.ground = null;
      const sp = V3.magnitude(this.v); if (sp > SHIP.modes.warp.v) V3.multiplyByScalar(this.v, SHIP.modes.warp.v / sp, this.v);
      this.say('Back in the Enceladus area.');
    }
    this.fwdGlow += ((fwd > 0 ? 1 : 0) - this.fwdGlow) * Math.min(1, dt * 6); this.upGlow = 0.05;
    this.place();
    for (const b of padBtns) b.classList.toggle('on', b._keys.some(x => k.has(x)));
  },
  step(dt) {
    if (dt <= 0) return;
    if (this.crashed) { this.crashStep(); return; }
    if (this.ap) { this.stepAuto(dt); return; }
    if (this.space) { this.stepSpace(dt); return; }
    const k = walk.keys, has = (...a) => a.some(x => k.has(x));
    const c0 = E.cartesianToCartographic(this.p, _carto), g0 = globe.getHeight(c0);
    if (g0 !== undefined) this.ground = g0;
    if (this.settling) {      // wait for the ground under the ship to load, then set it down (or hover above it)
      if (this.ground === null) return;
      const h = this.heading();
      this.p = V3.fromRadians(c0.longitude, c0.latitude, this.ground + SHIP.leg + (this.startAlt || 0), E, this.p); this.level(h);
      this.landed = !this.startAlt; this.alt = this.startAlt || 0; this.settling = false; this.place(); return;
    }
    // TURBO (Shift) and WARP (F) also fly forward on their own, on the keyboard and the touch pad (unless BACK is held)
    const boostGo = !has('s') && has('shift', 'f', 'j');
    const fwd = (has('w') || boostGo ? 1 : 0) - (has('s') ? 1 : 0);
    const turn = ((has('d', 'arrowright') ? 1 : 0) - (has('a', 'arrowleft') ? 1 : 0)) || this.ax.yaw;   // keys, or a controller's stick
    const pitchIn = ((has('arrowup') ? 1 : 0) - (has('arrowdown') ? 1 : 0)) || this.ax.pitch;
    const rollIn = ((has('e') ? 1 : 0) - (has('q') ? 1 : 0)) || this.ax.roll;
    let up = has('r', ' ');
    const down = has('c'), brake = has('x');
    this.mode = has('j') ? 'intra' : has('f') ? 'warp' : has('shift') ? 'turbo' : 'normal';
    const straight = this.mode === 'intra';      // the intrastellar drive goes straight where the nose points: up, out or down
    const M = SHIP.modes[this.mode];
    enuAt(this.p);
    const sp = V3.magnitude(this.v);
    // --- turning: pitch / yaw / roll about the ship's own axes, so loops and rolls just work ---
    const noseUp = V3.dot(this.f, _U), wingDown = -V3.dot(this.r, _U);       // sines of pitch and bank
    const slow = sp < 8 || this.landed;
    let pT = pitchIn * SHIP.pitch, yT = turn * Math.min(SHIP.yaw, 0.35 + M.a * 1.2 / Math.max(sp, 1)), rT = rollIn * SHIP.roll;
    // inv = -1 when flying upside down
    const upDot = V3.dot(this.u, _U), inv = upDot < 0 ? -1 : 1;
    // no auto-levelling: the nose keeps whatever angle to the horizon you gave it. It only turns with the moon's curve as
    // you fly over it (nose down at v/r), so a level nose stays level instead of slowly pointing off into space.
    const holdLevel = false;
    if (!straight && !pitchIn && Math.abs(upDot) > 0.3) pT = inv * -(V3.dot(this.v, this.f) / V3.magnitude(this.p));
    if (!rollIn && Math.abs(noseUp) < 0.6) {       // not rolling or looping: settle the wings, to whichever of upright or
      const bankT = slow || inv < 0 ? 0 : turn * 0.5 * Math.min(1, sp / 60);       // inverted is nearer (banking into turns)
      rT = inv * (bankT - Math.asin(clamp(wingDown, -1, 1))) * 2.5;
    }
    if (this.landed && !up && !fwd) { pT = -Math.asin(clamp(noseUp, -1, 1)) * 4; rT = -Math.asin(clamp(wingDown, -1, 1)) * 4; }
    const ease = Math.min(1, dt * 6);
    this.rates[0] += (pT - this.rates[0]) * ease; this.rates[1] += (yT - this.rates[1]) * ease; this.rates[2] += (rT - this.rates[2]) * ease;
    turnPair(this.f, this.u, this.rates[0] * dt);    // pitch: nose toward up
    turnPair(this.f, this.r, this.rates[1] * dt);    // yaw: nose toward right
    turnPair(this.u, this.r, this.rates[2] * dt);    // roll: top toward right (right wing down)
    this.orthonormalize();
    // --- flight assist: chase the velocity you ask for (nose direction and ship's up), zero when you let go ---
    const vF = fwd > 0 ? M.v : fwd < 0 ? -0.4 * M.v : 0, vU = up ? M.up : down ? -M.up : 0;
    comb(_vt, brake ? 0 : vF, this.f, brake ? 0 : vU, this.u);
    if (holdLevel && !up && !down) V3.subtract(_vt, V3.multiplyByScalar(_U, V3.dot(_vt, _U), _t1), _vt);   // and keep your height
    if (this.landed && fwd && !up) V3.add(_vt, V3.multiplyByScalar(_U, 5, _t1), _vt);   // hop off the ice to go
    const alt = c0.height - (this.ground ?? 0) - SHIP.leg, h = Math.max(0, alt);
    // hovering (not flying forward): never come down faster than you can stop in the height left, for soft landings.
    // Flying forward there is no such help: dive into the ice, or into a hill, and you crash.
    if (!fwd) {
      const vtU = V3.dot(_vt, _U), lim = -(0.8 + Math.min(Math.sqrt(2 * 0.4 * SHIP.modes.normal.a * h), h / 4) * (this.mode === 'normal' ? 1 : 3));
      if (vtU < lim) V3.add(_vt, V3.multiplyByScalar(_U, lim - vtU, _t1), _vt);
    }
    const r = V3.magnitude(this.p), gl = GM_ENC / (r * r);
    V3.multiplyByScalar(V3.subtract(_vt, this.v, _a), brake ? 3 : 1.5, _a);
    V3.add(_a, V3.multiplyByScalar(_U, gl, _t1), _a);                               // hold up against gravity
    // slowing down from above this mode's top speed uses the push of whichever mode that speed belongs to (warp stops fast)
    const slowing = brake || (fwd <= 0 && sp > M.v);
    const aLim = slowing ? Math.max(M.a, sp > SHIP.modes.warp.v ? SHIP.modes.intra.a : sp > SHIP.modes.turbo.v ? SHIP.modes.warp.a : SHIP.modes.turbo.a) : M.a;
    const am = V3.magnitude(_a);
    if (am > aLim) V3.multiplyByScalar(_a, aLim / am, _a);
    if (this.landed && !up && !fwd) V3.clone(V3.ZERO, _a);
    if (this.fuel <= 0 && this.mode !== 'warp' && this.mode !== 'intra') V3.clone(V3.ZERO, _a);
    // --- integrate: thrust and gravity ---
    V3.add(this.v, V3.multiplyByScalar(comb(_t3, 1, _a, -gl, _U), dt, _t2), this.v);
    V3.add(this.p, V3.multiplyByScalar(this.v, dt, _t2), this.p);
    if (this.mode !== 'warp' && this.mode !== 'intra' && !this.infinite) {
      const mass = SHIP.dry + this.fuel, was = this.fuel;
      this.fuel = Math.max(0, this.fuel - mass * V3.magnitude(_a) / (this.isp() * G0) * dt);
      if (was > 0 && this.fuel === 0) this.say('Out of propellant. WARP still works, or land and press Refuel.');
    }
    // looks: engines glow with the push forward, the belly jet with the push up
    const aF = V3.dot(_a, this.f), aU = V3.dot(_a, this.u);
    this.fwdGlow += (clamp(aF / SHIP.modes.normal.a, 0, 1) - this.fwdGlow) * Math.min(1, dt * 6);
    this.upGlow += (clamp(aU / SHIP.modes.normal.a, 0.05, 1) - this.upGlow) * Math.min(1, dt * 6);
    // --- the ground: skids stop you at the ice ---
    const c1 = E.cartesianToCartographic(this.p, _carto), g1 = globe.getHeight(c1);
    if (g1 !== undefined) this.ground = g1;
    const floor = (this.ground ?? 0) + SHIP.leg;
    this.alt = c1.height - floor;
    enuAt(this.p);
    if (c1.height <= floor) {
      const vr = V3.dot(this.v, _U);
      this.p = V3.fromRadians(c1.longitude, c1.latitude, floor, E, this.p);
      const hs = V3.magnitude(V3.subtract(this.v, V3.multiplyByScalar(_U, vr, _t2), _t3));
      if (!this.landed && (-vr > CRASH_VS || hs > CRASH_HS || (V3.dot(this.u, _U) < 0.5 && V3.magnitude(this.v) > 3))) { this.crash(V3.magnitude(this.v)); return; }
      if (vr < 0) {
        if (!this.landed && -vr > 0.05) this.say(`Touchdown at ${(-vr).toFixed(1)} m/s. Nice.`);
        V3.add(this.v, V3.multiplyByScalar(_U, -vr, _t2), this.v);
      }
      this.landed = true; this.alt = 0;
    } else if (this.alt > 0.3) this.landed = false;
    if (this.landed && !up && !fwd) {      // skids on the ice: sliding stops
      const vr = V3.dot(this.v, _U), damp = Math.max(0, 1 - 4 * dt);
      comb(this.v, damp, this.v, (1 - damp) * vr, _U);
    }
    if (c1.height > SHIP.maxAlt) this.enterSpace();       // out of the Enceladus area, into orbit space
    this.place();
    // light up the on-screen buttons for whatever is held, keyboard included
    for (const b of padBtns) b.classList.toggle('on', b._keys.some(x => k.has(x)));
  },
  camera() {
    const V = VIEWS[this.view];
    if (!V.d) {      // cockpit: look out over the nose
      this.prims.hull.show = false;
      camera.setView({ destination: comb(_t1, 1, this.p, 4.6, this.f, 1.7, this.u), orientation: { direction: V3.clone(this.f), up: V3.clone(this.u) } });
      return;
    }
    this.prims.hull.show = !this.crashed;
    // chase: behind the ship and a little above it, rolling and looping with it; drag swings the camera around
    let d = V.d * this.zoom * (innerHeight > innerWidth ? 2.2 : 1); const cp = this.camPitch;
    if (this.space) d = Math.min(d, Math.max(5, this.dS / 300));   // Saturn is drawn 100x nearer (placeSky): keep the camera in front of it
    const back = comb(_t3, Math.cos(this.camYaw), this.f, Math.sin(this.camYaw), this.r);
    const pos = comb(new V3(), 1, this.p, -Math.cos(cp) * d, back, Math.sin(cp) * d + 3, this.u);
    const c = E.cartesianToCartographic(pos), gh = c && globe.getHeight(c);
    if (c && gh !== undefined && c.height < gh + 2) V3.fromRadians(c.longitude, c.latitude, gh + 2, E, pos);
    const dir = V3.normalize(V3.subtract(comb(_t1, 1, this.p, 2, this.u), pos, _t1), new V3());
    const right = V3.normalize(V3.cross(dir, this.u, _t2), _t2), upv = V3.cross(right, dir, new V3());
    camera.setView({ destination: pos, orientation: { direction: dir, up: upv } });
  },
  // the altimeter strip (bottom centre): height, climb rate, speed and drive every frame, with a warning before impact
  fhud() {
    const el = this._fh || (this._fh = { box: $('flighthud'), alt: $('fhAlt'), altK: $('fhAltK'), vs: $('fhVs'), spd: $('fhSpd'), mode: $('fhMode') });
    const spd = V3.magnitude(this.v);
    if (this.crashed) {
      el.box.className = 'crash'; el.altK.textContent = 'Altitude'; el.alt.textContent = 'CRASHED'; el.vs.textContent = 'new ship coming'; el.spd.textContent = '—'; el.mode.textContent = '—';
      return;
    }
    if (this.space) {
      el.box.className = 'space'; el.altK.textContent = this.inSat ? "Above Saturn's clouds" : 'To Saturn';
      el.alt.textContent = fmtD(this.dS); el.vs.textContent = `Enceladus ${fmtD(this.dE)}`;
    } else {
      enuAt(this.p); const vs = V3.dot(this.v, _U), a = Math.max(0, this.alt);
      const danger = !this.ap && !this.landed && !this.settling && vs < -1 && a / -vs < 4 && a < 5000;
      el.box.className = danger ? 'warn' : '';
      el.altK.textContent = danger ? 'Pull up!' : 'Altitude';
      el.alt.textContent = fmtD(a);
      el.vs.textContent = `${vs > 0.5 ? '▲' : vs < -0.5 ? '▼' : '■'} ${fmtV(Math.abs(vs))}`;
    }
    el.spd.textContent = fmtV(spd);
    el.mode.textContent = this.ap ? 'AUTOPILOT' : MODE_NAME[this.mode] || 'CRUISE'; el.mode.dataset.m = this.ap ? 'auto' : this.mode;
  },
  look(dx, dy) { this.camYaw += dx * 0.005; this.camPitch = clamp(this.camPitch + dy * 0.004, -0.6, 1.5); },
  hud() {
    const fm = $('flymsg'), fresh = performance.now() - this.msgT < 9000 && this.msg ? this.msg : '';   // phones: messages show under the readout
    if (fm.textContent !== fresh) fm.textContent = fresh;
    if (this.space) {
      const spd = V3.magnitude(this.v), mass = SHIP.dry + this.fuel, dv = this.isp() * G0 * Math.log(mass / SHIP.dry);
      $('shippad').classList.remove('hide'); $('shipmap').classList.remove('hide');
      sysMap.draw();
      $('walktitle').textContent = (this.inSat ? 'Saturn area' : 'Orbit space') + (MODE_NAME[this.mode] ? ' · ' + MODE_NAME[this.mode] : '');
      if (this.ap) $('walktitle').textContent = 'Autopilot · ' + this.apText;
      $('shipalt').textContent = `${fmtD(this.dS)} above Saturn's clouds`;
      $('shipspd').textContent = fmtV(spd);
      $('shipatt').textContent = `Enceladus is ${fmtD(this.dE)} away`;
      $('shipfuel').textContent = this.infinite ? 'Unlimited' : `${Math.round(100 * this.fuel / SHIP.prop)}% · ${(dv / 1000).toFixed(0)} km/s of Δv`;
      $('shipstat').textContent = performance.now() - this.msgT < 9000 && this.msg ? this.msg
        : this.inSat ? 'In the Saturn area' : 'Between Enceladus and Saturn';
      $('shipmp').textContent = mp.summary();
      $('shipView').textContent = 'View: ' + VIEWS[this.view].name;
      $('shipOut').disabled = true; $('shipRefuel').disabled = true;
      return;
    }
    const c = E.cartesianToCartographic(this.p); enuAt(this.p);
    const spd = V3.magnitude(this.v), rr = V3.magnitude(this.p), vorb = Math.sqrt(GM_ENC / rr);
    const mass = SHIP.dry + this.fuel, dv = this.isp() * G0 * Math.log(mass / SHIP.dry);
    const nose = Math.asin(clamp(V3.dot(this.f, _U), -1, 1)) / D2R_F, upside = V3.dot(this.u, _U) < 0;
    $('shippad').classList.remove('hide'); $('shipmap').classList.remove('hide');
    $('walktitle').textContent = this.settling ? 'Getting ready…' : this.landed ? 'Landed' : 'Flying' + (MODE_NAME[this.mode] ? ' · ' + MODE_NAME[this.mode] : '');
    if (this.ap) $('walktitle').textContent = 'Autopilot · ' + this.apText;
    $('shipalt').textContent = `${fmtD(this.alt)} above the ice`;
    $('shipspd').textContent = `${fmtV(spd)} · orbit here ${vorb.toFixed(0)} m/s`;
    $('shipatt').textContent = `nose ${Math.abs(nose).toFixed(0)}° ${nose >= 0 ? 'up' : 'down'}${upside ? ' · upside down' : ''}`;
    $('shipfuel').textContent = this.infinite ? 'Unlimited' : `${Math.round(100 * this.fuel / SHIP.prop)}% · ${(dv / 1000).toFixed(0)} km/s of Δv`;
    $('shipstat').textContent = performance.now() - this.msgT < 9000 && this.msg ? this.msg
      : `${Math.abs(c.latitude / D2R_F).toFixed(3)}°${c.latitude >= 0 ? 'N' : 'S'}, ${Math.abs(c.longitude / D2R_F).toFixed(3)}°${c.longitude >= 0 ? 'E' : 'W'}`;
    $('shipmp').textContent = mp.summary();
    $('shipView').textContent = 'View: ' + VIEWS[this.view].name;
    $('shipOut').disabled = !this.landed; $('shipRefuel').disabled = !this.landed || this.fuel >= SHIP.prop - 1;
    sysMap.label(false);
    shipMap.draw(c.latitude / D2R_F, c.longitude / D2R_F, this.heading(), this.alt);
  },
};

// ---------- in orbit space the map shows the Saturn system from above (the ring plane), with a ring-plane gauge ----------
// Ring edges and moon orbit sizes are real (km from Saturn's centre). Enceladus is where it really is in this view (this
// globe turns with Enceladus, so it stays put); the other moons go round at their real rates relative to it, but where
// each one starts is made up, and they are on the map only, not drawn in 3D.
const GM_SAT = 3.7931e16;
const SATMOONS = [['Mimas', 185539e3, 0.6], ['Enceladus', SATURN_D, null], ['Tethys', 294619e3, 2.4], ['Dione', 377396e3, 4.1], ['Rhea', 527108e3, 5.3], ['Titan', 1221870e3, 1.9]];
const RINGS = [[74658e3, 92000e3, 'rgba(170,150,120,.38)'], [92000e3, 117580e3, 'rgba(228,208,168,.88)'], [122170e3, 136775e3, 'rgba(208,188,152,.62)']];   // C, B, A
const RING_IN = 74658e3, RING_OUT = 140180e3;
const sysMap = {
  cap0: null,
  label(space) {
    const box = $('shipmap'), head = box.querySelector('.head b'), cap = box.querySelector('.cap');
    if (this.cap0 === null) this.cap0 = cap.textContent;
    head.textContent = space ? 'Saturn system' : 'Map';
    $('shipMapZoom').textContent = shipMap.zoom === 1 ? 'Zoom in' : space ? 'Whole system' : 'Whole moon';
    if (!space) cap.textContent = this.cap0;
  },
  draw() {
    this.label(true);
    const mc = $('shipmapc'); if (mc.offsetWidth < 20) return;
    const { w, h, d } = shipMap.size(mc), ctx = mc.getContext('2d'), cx = w / 2, cy = h / 2;
    const rx = ship.p.x - SATURN_D, ry = ship.p.y, rz = ship.p.z, rho = Math.hypot(rx, ry);
    const span = shipMap.zoom === 1 ? Math.min(1.35e9, Math.max(3.2e8, rho * 1.25)) : 1.6e8, S = (w / 2 - 2 * d) / span;
    ctx.clearRect(0, 0, w, h);
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, w / 2 - d, 0, 7); ctx.fillStyle = '#03060c'; ctx.fill(); ctx.clip();
    const t = Date.now() / 1000, nE = Math.sqrt(GM_SAT / Math.pow(SATURN_D, 3));
    ctx.font = `${9.5 * d}px Inter,sans-serif`; ctx.textAlign = 'center';
    for (const [name, a, th0] of SATMOONS) {
      const r = a * S; if (r > w) continue;
      ctx.strokeStyle = name === 'Enceladus' ? 'rgba(138,180,248,.5)' : 'rgba(138,180,248,.2)'; ctx.lineWidth = d;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
      const ang = th0 === null ? Math.PI : th0 + (Math.sqrt(GM_SAT / (a * a * a)) - nE) * t;
      const mx = cx + r * Math.cos(ang), my = cy - r * Math.sin(ang), enc = name === 'Enceladus';
      ctx.fillStyle = enc ? '#dff0ff' : '#9fb2c8'; ctx.beginPath(); ctx.arc(mx, my, (enc ? 3.6 : 2.6) * d, 0, 7); ctx.fill();
      ctx.fillStyle = enc ? '#dff0ff' : 'rgba(180,195,215,.85)'; ctx.fillText(name, mx, my - 6 * d);
    }
    for (const [r0, r1, col] of RINGS) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, Math.max(r1 * S, 2 * d), 0, 7); ctx.arc(cx, cy, Math.max(r0 * S, 1.5 * d), 0, 7, true); ctx.fill(); }
    ctx.strokeStyle = 'rgba(220,200,160,.55)'; ctx.lineWidth = Math.max(0.6, 0.6 * d); ctx.beginPath(); ctx.arc(cx, cy, RING_OUT * S, 0, 7); ctx.stroke();   // F ring
    ctx.fillStyle = '#e3c98f'; ctx.beginPath(); ctx.arc(cx, cy, Math.max(SATURN_R * S, 2.5 * d), 0, 7); ctx.fill();
    // you: an arrow along your heading (as seen from above the ring plane), pinned to the edge if off the map
    let sx = rx * S, sy = -ry * S; const lim = w / 2 - 8 * d, k = Math.hypot(sx, sy) > lim ? lim / Math.hypot(sx, sy) : 1;
    sx *= k; sy *= k;
    ctx.save(); ctx.translate(cx + sx, cy + sy); ctx.rotate(Math.atan2(ship.f.x, ship.f.y));
    ctx.fillStyle = '#8ab4f8'; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 1.5 * d;
    ctx.beginPath(); ctx.moveTo(0, -10 * d); ctx.lineTo(5.5 * d, 6 * d); ctx.lineTo(0, 2.5 * d); ctx.lineTo(-5.5 * d, 6 * d); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore(); ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(cx, cy, w / 2 - d, 0, 7); ctx.stroke();
    const overRings = rho > RING_IN && rho < RING_OUT, side = rz >= 0 ? 'north of' : 'south of';
    $('shipmap').querySelector('.cap').textContent = Math.abs(rz) < 2e3 && overRings ? 'You are crossing the ring plane, inside the rings!'
      : `${fmtD(Math.abs(rz))} ${side} the ring plane · ${fmtD(rho)} from Saturn's centre${overRings ? ', over the rings' : ''}. Moons go round at real rates; their places are illustrative.`;
    this.gauge(rz, overRings);
  },
  // height above (north) or below (south) the ring plane, on a log scale out to 1,000,000 km either way
  gauge(z, overRings) {
    const gc = $('shipgauge'); if (gc.offsetWidth < 10) return;
    const { w, h, d } = shipMap.size(gc), ctx = gc.getContext('2d'), mid = h / 2, half = h / 2 - 10 * d;
    const Y = m => mid - Math.sign(m) * half * Math.log10(1 + Math.abs(m) / 1e3) / Math.log10(1 + 1e6);
    const bx = 6 * d, bw = 10 * d;
    ctx.clearRect(0, 0, w, h);
    const grd = ctx.createLinearGradient(0, mid - half, 0, mid + half); grd.addColorStop(0, '#05070b'); grd.addColorStop(0.5, '#2a3348'); grd.addColorStop(1, '#05070b');
    ctx.fillStyle = grd; ctx.fillRect(bx, mid - half, bw, 2 * half);
    ctx.fillStyle = overRings ? '#f2d9a0' : 'rgba(228,208,168,.7)'; ctx.fillRect(bx - 2 * d, mid - (overRings ? 1.5 : 0.75) * d, bw + 4 * d, (overRings ? 3 : 1.5) * d);
    ctx.font = `${9 * d}px Inter,sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = '#9aa4b2';
    for (const [m, t] of [[1e8, '+100k km'], [1e6, '+1k km'], [0, 'rings'], [-1e6, '−1k km'], [-1e8, '−100k km']]) {
      ctx.fillRect(bx + bw, Y(m) - 0.5 * d, 3 * d, d); ctx.fillText(t, bx + bw + 5 * d, Y(m) + 3 * d);
    }
    ctx.fillStyle = '#ffd36b'; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = d;
    const y = Y(z);
    ctx.beginPath(); ctx.moveTo(bx - 4 * d, y - 4 * d); ctx.lineTo(bx + 2 * d, y); ctx.lineTo(bx - 4 * d, y + 4 * d); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillRect(bx, y - 0.75 * d, bw, 1.5 * d);
  },
};

// ---------- the map (top right): the moon centred on you, north up, your heading, and a height gauge ----------
const shipMap = {
  zoom: 1, img: null, w: 0, h: 0, loading: false,
  load() {      // level-2 mosaic tiles (8 x 4 of 256 px) assembled into one equirectangular image, as in Dive
    if (this.loading) return; this.loading = true;
    const cw = 2048, ch = 1024, off = document.createElement('canvas'); off.width = cw; off.height = ch;
    const ctx = off.getContext('2d'); let left = 32;
    const done = () => { if (--left === 0) { this.img = ctx.getImageData(0, 0, cw, ch).data; this.w = cw; this.h = ch; } };
    for (let x = 0; x < 8; x++) for (let y = 0; y < 4; y++) {
      const im = new Image(); im.onload = () => { ctx.drawImage(im, x * 256, y * 256); done(); }; im.onerror = done;
      im.src = `tiles/mosaic/2/${x}/${y}.jpg`;
    }
  },
  size(c) {
    const r = c.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, d };
  },
  // orthographic projection centred on (lat0, lon0); zoom 1 shows the whole hemisphere
  project(lat, lon, lat0, lon0, R) {
    const p = lat * D2R_F, l = (lon - lon0) * D2R_F, p0 = lat0 * D2R_F;
    const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
    if (cosc < 0) return null;
    return { x: R * Math.cos(p) * Math.sin(l), y: R * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l)) };
  },
  unproject(nx, ny, lat0, lon0) {
    const rho = Math.hypot(nx, ny); if (rho > 1) return null;
    const c = Math.asin(rho), p0 = lat0 * D2R_F;
    if (rho < 1e-9) return { lat: lat0, lon: lon0 };
    const lat = Math.asin(Math.cos(c) * Math.sin(p0) + ny * Math.sin(c) * Math.cos(p0) / rho) / D2R_F;
    const lon = lon0 + Math.atan2(nx * Math.sin(c), rho * Math.cos(c) * Math.cos(p0) - ny * Math.sin(c) * Math.sin(p0)) / D2R_F;
    return { lat, lon: ((lon + 540) % 360) - 180 };
  },
  draw(lat0, lon0, hd, alt) {
    const mc = $('shipmapc'); if (mc.offsetWidth < 20) return;
    if (!this.img) this.load();
    this.here = { lat: lat0, lon: lon0 };
    const { w, h, d } = this.size(mc), ctx = mc.getContext('2d');
    const cx = w / 2, cy = h / 2, R = (w / 2 - 2 * d) * this.zoom;
    const img = ctx.createImageData(w, h), px = img.data;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4, dx = i - cx, dy = cy - j;
      if (dx * dx + dy * dy > (w / 2) * (w / 2)) continue;              // round window
      const nx = dx / R, ny = dy / R, rho2 = nx * nx + ny * ny;
      if (rho2 > 1) { px[k] = 2; px[k + 1] = 8; px[k + 2] = 16; px[k + 3] = 255; continue; }
      const q = this.unproject(nx, ny, lat0, lon0);
      let v = 60;
      if (this.img) {
        const sx = Math.min(this.w - 1, Math.max(0, Math.floor((q.lon + 180) / 360 * this.w)));
        const sy = Math.min(this.h - 1, Math.max(0, Math.floor((90 - q.lat) / 180 * this.h)));
        v = this.img[(sy * this.w + sx) * 4];
      }
      const limb = 0.55 + 0.45 * Math.sqrt(1 - rho2);
      px[k] = v * limb * 0.85; px[k + 1] = v * limb * 0.93; px[k + 2] = v * limb; px[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#ff9a3c';      // plume jet sources
    (jets || []).forEach(jt => { const q = this.project(jt.lat, jt.lon, lat0, lon0, R); if (q && Math.hypot(q.x, q.y) < w / 2 - 3 * d) { ctx.beginPath(); ctx.arc(cx + q.x, cy - q.y, 1.6 * d, 0, 7); ctx.fill(); } });
    ctx.strokeStyle = 'rgba(138,180,248,.35)'; ctx.lineWidth = d; ctx.beginPath(); let pen = false;   // the equator
    for (let lo = -180; lo <= 180; lo += 3) { const q = this.project(0, lo, lat0, lon0, R); if (q && Math.hypot(q.x, q.y) < w / 2) { pen ? ctx.lineTo(cx + q.x, cy - q.y) : ctx.moveTo(cx + q.x, cy - q.y); pen = true; } else pen = false; }
    ctx.stroke();
    // the point under Saturn (0°, 0°): Saturn is straight overhead there
    const sq = this.project(0, 0, lat0, lon0, R);
    if (sq && Math.hypot(sq.x, sq.y) < w / 2 - 6 * d) { ctx.fillStyle = '#e8c98a'; ctx.beginPath(); ctx.arc(cx + sq.x, cy - sq.y, 3.2 * d, 0, 7); ctx.fill(); }
    [[90, 'N'], [-90, 'S']].forEach(([la, t]) => { const q = this.project(la, 0, lat0, lon0, R); if (q && Math.hypot(q.x, q.y) < w / 2 - 8 * d) { ctx.fillStyle = 'rgba(207,227,245,.8)'; ctx.font = `${10 * d}px Inter,sans-serif`; ctx.textAlign = 'center'; ctx.fillText(t, cx + q.x, cy - q.y + 4 * d); } });
    for (const o of mp.peers.values()) {      // other players: coloured dots
      if (!o.cur) continue;
      const q = this.project(o.cur.lat, o.cur.lon, lat0, lon0, R);
      if (q && Math.hypot(q.x, q.y) < w / 2 - 3 * d) { ctx.fillStyle = o.css; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = d; ctx.beginPath(); ctx.arc(cx + q.x, cy - q.y, 3.4 * d, 0, 7); ctx.fill(); ctx.stroke(); }
    }
    // you: an arrow pointing your heading
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(hd);
    ctx.fillStyle = '#8ab4f8'; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 1.5 * d;
    ctx.beginPath(); ctx.moveTo(0, -11 * d); ctx.lineTo(6 * d, 6 * d); ctx.lineTo(0, 2.5 * d); ctx.lineTo(-6 * d, 6 * d); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(cx, cy, w / 2 - d, 0, 7); ctx.stroke();
    this.gauge(alt);
  },
  // height above the ice on a log scale from 1 m to 1,500 km, with the moon's size marked for scale
  gauge(alt) {
    const gc = $('shipgauge'); if (gc.offsetWidth < 10) return;
    const { w, h, d } = this.size(gc), ctx = gc.getContext('2d');
    const top = 8 * d, bot = h - 8 * d, Y = m => bot - (bot - top) * Math.log10(1 + Math.max(0, m)) / Math.log10(1 + 1.5e6);
    const bx = 6 * d, bw = 10 * d;
    ctx.clearRect(0, 0, w, h);
    const grd = ctx.createLinearGradient(0, top, 0, bot); grd.addColorStop(0, '#05070b'); grd.addColorStop(1, '#2a3f63');
    ctx.fillStyle = grd; ctx.fillRect(bx, top, bw, bot - top);
    ctx.fillStyle = '#e8f1f8'; ctx.fillRect(bx, bot, bw, 4 * d);
    ctx.font = `${9 * d}px Inter,sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = '#9aa4b2';
    for (const [m, t] of [[10, '10 m'], [1e3, '1 km'], [1e5, '100 km'], [1.5e6, '1500 km']]) { ctx.fillRect(bx + bw, Y(m) - 0.5 * d, 3 * d, d); ctx.fillText(t, bx + bw + 5 * d, Y(m) + 3 * d); }
    ctx.fillStyle = '#ffd36b'; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = d;
    const y = Y(alt);
    ctx.beginPath(); ctx.moveTo(bx - 4 * d, y - 4 * d); ctx.lineTo(bx + 2 * d, y); ctx.lineTo(bx - 4 * d, y + 4 * d); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillRect(bx, y - 0.75 * d, bw, 1.5 * d);
  },
};
$('shipmapc').addEventListener('click', e => {
  const mc = $('shipmapc'), r = mc.getBoundingClientRect(), Rcss = (r.width / 2 - 2) * shipMap.zoom;
  const nx = (e.clientX - r.left - r.width / 2) / Rcss, ny = (r.top + r.height / 2 - e.clientY) / Rcss;
  if (ship.space) return;      // the Saturn system map is for looking, not jumping
  const here = shipMap.here, q = here && shipMap.unproject(nx, ny, here.lat, here.lon);
  if (q && !$('appanel').classList.contains('hide') && $('apDest').value === 'map') {      // picking an autopilot destination
    ship.apPick = { lat: q.lat, lon: q.lon }; ship.apSync(); if (ship.ap) ship.apEngage(); return;
  }
  if (q && ship.on) { ship.jumpTo(q.lat, q.lon); ship.hud(); }
});
$('shipMapZoom').onclick = () => { shipMap.zoom = shipMap.zoom === 1 ? 6 : 1; ship.hud(); };

// ---------- autopilot: pick a destination and it flies you there, then cruises in orbit, hovers or lands ----------
// A simple, safe route: climb out and round to the side facing the destination, cross on the drives, come in to a
// "shell" above the target body, follow the curve of that body round to the spot while easing to the altitude you set,
// then settle in. Touch any flight control to take over. No propellant is used. Orbits go at the real circular-orbit
// speed for that height, or 10x / 100x faster for sightseeing.
const AP_BODIES = {
  enc: { name: 'Enceladus', c: new V3(0, 0, 0), GM: GM_ENC, R, shell: 300e3, vcap: 1e5, surf: () => R },
  sat: { name: 'Saturn', c: SAT, GM: GM_SAT, R: SATURN_R, shell: 20000e3, vcap: LIGHT, surf: n => satR(n) },
};
const AP_KEYS = new Set(['w', 's', 'a', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'r', 'c', 'shift', 'f', 'j', 'x']);
const AP_TO_SAT = new V3(1, 0, 0), AP_TO_ENC = new V3(-1, 0, 0);
const _ap1 = new V3(), _ap2 = new V3(), _ap3 = new V3(), _apv = new V3(), _ap4 = new V3();
const fmtT = s => s < 5400 ? `${Math.max(1, Math.round(s / 60))} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`;
const AP_DESTS = (() => {
  const enc = (lat, lon) => ({ body: 'enc', lat, lon });
  const list = [
    { id: 'here', body: 'enc', label: 'Enceladus · right where I am', get: () => { const c = E.cartesianToCartographic(ship.p); return enc(c.latitude / D2R_F, c.longitude / D2R_F); } },
    { id: 'stripes', body: 'enc', label: 'Enceladus · Tiger Stripes (Baghdad–Damascus)', get: () => enc(-81.5, -30) },
    { id: 'subsat', body: 'enc', label: 'Enceladus · the point under Saturn', get: () => enc(0, 0) },
    { id: 'map', body: 'enc', label: 'Enceladus · a spot I click on the map', get: () => ship.apPick ? enc(ship.apPick.lat, ship.apPick.lon) : null },
    { id: 'satcloud', body: 'sat', alt: 10000, label: 'Saturn · above the clouds, facing Enceladus', get: () => ({ body: 'sat', dir: new V3(-1, 0, 0) }) },
    { id: 'satpole', body: 'sat', alt: 15000, label: 'Saturn · over the north-pole hexagon', get: () => ({ body: 'sat', dir: new V3(0, 0, 1) }) },
    { id: 'cassini', body: 'sat', alt: Math.round((119875e3 - SATURN_R) / 1e3), label: 'Saturn · the Cassini Division, in the ring plane', get: () => ({ body: 'sat', dir: new V3(-1, 0, 0), plane: true, zOff: 0 }) },
    { id: 'aring', body: 'sat', alt: Math.round((130000e3 - SATURN_R) / 1e3), label: 'Saturn · skimming 400 km over the A ring', get: () => ({ body: 'sat', dir: new V3(-1, 0, 0), plane: true, zOff: 400e3 }) },
  ];
  for (const f of [...(window.ENC_FEATURES || [])].sort((a, b) => a.name.localeCompare(b.name)))
    list.push({ id: 'f:' + f.name, body: 'enc', group: true, label: `Enceladus · ${f.name} (${String(f.type).toLowerCase()})`, get: () => enc(f.lat, f.lon) });
  return list;
})();
Object.assign(ship, {
  ap: null, apPick: null, apText: '', apMode: 'orbit', apGnd: 0,
  apEngage() {
    const d = AP_DESTS.find(x => x.id === $('apDest').value), D = d && d.get();
    if (!D) { $('apNote').textContent = 'Click a spot on the map (top right) first.'; return; }
    const alt = this.apAltNow(); if (alt === null) { $('apNote').textContent = 'Set an altitude first (a number, 0 or more).'; return; }
    const n = D.body === 'enc' ? V3.normalize(V3.fromDegrees(D.lon, D.lat, 0, E), new V3()) : V3.normalize(D.dir, new V3());
    let mode = this.apMode; if (D.body === 'sat' && mode === 'land') mode = 'orbit';
    this.ap = { body: D.body, n, alt: D.body === 'enc' ? Math.max(5, alt) : Math.max(500e3, alt), mode, mul: +$('apSpeed').value, plane: !!D.plane, zOff: D.zOff || 0, phase: 'transit', axis: null, name: d.label.replace(/^[^·]*· /, '') };
    this.settling = false; this.landed = false; this.rates = [0, 0, 0];
    if (D.body === 'sat' && V3.magnitude(this.p) - R < SHIP.maxAlt) this.ap.phase = 'leaveEnc';
    else if (D.body === 'enc' && this.p.x > SATURN_D && V3.distance(this.p, SAT) < SATURN_R + 60000e3) this.ap.phase = 'leaveSat';
    this.say(`Autopilot on: heading for ${this.ap.name}.`); this.apUI(); this.hud();
    $('appanel').classList.add('mini');      // out of the way, so you can watch the flight
  },
  apOff(msg) {
    this.ap = null; this.apUI();
    if ($('appanel').classList.contains('mini')) $('appanel').classList.add('hide');
    $('appanel').classList.remove('mini');
    this.space = V3.magnitude(this.p) - R > SHIP.maxAlt; this.inSat = V3.distance(this.p, SAT) < SAT_AREA;
    if (!this.space) this.ground = null;
    if (msg) this.say(msg);
    this.hud();
  },
  apSetMode(m) {
    const A = this.ap; if (!A || (A.body === 'sat' && m === 'land')) return;
    A.mode = m; if (['orbit', 'hover', 'land'].includes(A.phase)) { A.phase = m; A.axis = null; }
  },
  apUI() {
    const on = !!this.ap;
    $('apGo').textContent = on ? 'Disengage autopilot' : 'Engage autopilot'; $('apGo').classList.toggle('stop', on);
    $('apState').textContent = on ? 'On' : 'Off'; $('apState').classList.toggle('on', on);
    $('apStatus').textContent = on ? (this.ap.name + (this.apText ? ' · ' + this.apText : '')) : '';
  },
  // the velocity that follows body Bd's curve toward direction nT at height hT; returns how far round and how high
  apShell(Bd, nT, hT, out) {
    const rel = V3.subtract(this.p, Bd.c, _ap1), r = V3.magnitude(rel), n = V3.divideByScalar(rel, r, _ap2);
    const h = r - (Bd === AP_BODIES.enc ? R + this.apGnd + SHIP.leg : Bd.surf(n));
    const cosd = clamp(V3.dot(n, nT), -1, 1), d = Math.acos(cosd), arc = d * r;
    const t = V3.subtract(nT, V3.multiplyByScalar(n, cosd, _ap3), _ap3), tl = V3.magnitude(t);
    if (tl > 1e-9) V3.divideByScalar(t, tl, t);
    else if (d > 1) V3.normalize(V3.cross(n, Math.abs(n.z) < 0.9 ? V3.UNIT_Z : V3.UNIT_X, t), t);
    else V3.clone(V3.ZERO, t);
    const vt = Math.min(Bd.vcap, 3 * (Math.max(h, 0) + 0.02 * Bd.R), 0.8 * arc + 2);
    const vrm = Math.max(30, 0.4 * Math.max(h, hT)); let vr = clamp((hT - h) * 0.8, -vrm, vrm);
    if (Bd === AP_BODIES.enc && h < 25) vr = Math.max(vr, 20);
    comb(out, vt, t, vr, n);
    return { arc, h };
  },
  stepAuto(dt) {
    const A = this.ap;
    for (const x of walk.keys) if (AP_KEYS.has(x)) { this.apOff('Autopilot off: you have control.'); return; }
    if (Math.max(Math.abs(this.ax.pitch), Math.abs(this.ax.yaw), Math.abs(this.ax.roll)) > 0.5) { this.apOff('Autopilot off: you have control.'); return; }
    const B = AP_BODIES[A.body], P = A.phase;
    const cE = E.cartesianToCartographic(this.p, _carto);
    let gE = this.apGnd;
    if (cE && cE.height < 60e3) { const g = globe.getHeight(cE); if (g !== undefined) { gE = g; this.ground = g; } } else gE = 0;
    this.apGnd = gE;
    let status = '', moved = false;
    if (P === 'leaveEnc') {      // up and round to the Saturn-facing side of Enceladus, so the way across is clear
      this.apShell(AP_BODIES.enc, AP_TO_SAT, Math.max(1500e3, V3.magnitude(this.p) - R), _apv);
      if (V3.magnitude(this.p) - R > 1300e3 && this.p.x / V3.magnitude(this.p) > 0.2) A.phase = 'transit';
      status = 'climbing out of the Enceladus area';
    } else if (P === 'leaveSat') {      // round to the Enceladus side of Saturn first
      this.apShell(AP_BODIES.sat, AP_TO_ENC, Math.max(20000e3, satAlt(this.p)), _apv);
      if ((this.p.x - SATURN_D) / V3.distance(this.p, SAT) < -0.2) A.phase = 'transit';
      status = 'swinging round Saturn';
    } else if (P === 'transit') {      // straight across to the nearest point of the shell above the target body
      const rel = V3.subtract(this.p, B.c, _ap1), r = V3.magnitude(rel), n = V3.divideByScalar(rel, r, _ap2);
      const hs = Math.max(A.alt, B.shell), Pt = V3.add(B.c, V3.multiplyByScalar(n, B.surf(n) + hs, _ap3), _ap3);
      const to = V3.subtract(Pt, this.p, _apv), dist = V3.magnitude(to);
      if (dist < Math.max(2e3, 0.03 * hs)) A.phase = 'shell';
      V3.multiplyByScalar(to, dist > 0 ? Math.min(LIGHT, 1.2 * Math.max(5e3, dist)) / dist : 0, _apv);
      status = `on the way to ${B.name} · ${fmtD(dist)} to go`;
    } else if (P === 'shell') {      // round the curve of the body to the spot, easing to the set altitude
      const s = this.apShell(B, A.n, A.alt, _apv);
      status = `${fmtD(s.arc)} to go · ${fmtD(Math.max(0, s.h))} up`;
      if (s.arc < Math.max(50, 0.0005 * B.R) && Math.abs(s.h - A.alt) < Math.max(15, 0.03 * A.alt)) {
        A.phase = A.mode; A.axis = null;
        this.say(A.mode === 'hover' ? `Arrived: hovering ${fmtD(A.alt)} over ${A.name}.` : A.mode === 'land' ? `Arrived over ${A.name}: coming in to land.` : `Arrived: cruising in orbit around ${B.name}.`);
      }
    } else if (P === 'hover' || P === 'land') {
      const enc = B === AP_BODIES.enc;
      let surfT = enc ? R : satR(A.n);
      if (enc) { const ct = E.cartesianToCartographic(V3.multiplyByScalar(A.n, R, _ap4)); const g = ct && globe.getHeight(ct); surfT = R + (g === undefined ? gE : g) + SHIP.leg; }
      const rel = V3.subtract(this.p, B.c, _ap1), r = V3.magnitude(rel), n = V3.divideByScalar(rel, r, _ap2);
      const h = r - (enc ? R + gE + SHIP.leg : satR(n));
      if (P === 'hover') {
        const Pt = V3.add(B.c, V3.multiplyByScalar(A.n, surfT + A.alt, _ap3), _ap3), to = V3.subtract(Pt, this.p, _apv), dist = V3.magnitude(to);
        const vm = Math.max(20, 0.5 * dist); V3.multiplyByScalar(to, Math.min(1.2, dist > 0 ? vm / dist : 0), _apv);
        status = `hovering ${fmtD(Math.max(0, h))} over ${A.name}`;
      } else {
        const Pt = V3.add(B.c, V3.multiplyByScalar(A.n, surfT, _ap3), _ap3), to = V3.subtract(Pt, this.p, _ap4);
        const tan = V3.subtract(to, V3.multiplyByScalar(n, V3.dot(to, n), _ap3), _ap3);
        comb(_apv, 1, tan, -clamp(h / 4, 1.5, 60), n);
        status = `landing · ${fmtD(Math.max(0, h))} to go`;
        if (h < 0.6) {      // down: stand on the ice, autopilot off, the normal ship takes over
          const c = E.cartesianToCartographic(this.p);
          this.p = V3.fromRadians(c.longitude, c.latitude, gE + SHIP.leg, E, this.p); V3.clone(V3.ZERO, this.v);
          this.landed = true; this.alt = 0; this.level(this.heading());
          this.apOff(`Landed on ${A.name}. Autopilot off.`); this.place(); return;
        }
      }
    } else if (P === 'orbit') {      // a circular orbit at the set altitude (ring-plane orbits keep to the ring plane)
      const rel = V3.subtract(this.p, B.c, _ap1), r = V3.magnitude(rel), n = V3.divideByScalar(rel, r, _ap2);
      const surf = B === AP_BODIES.enc ? R + gE + SHIP.leg : satR(n), rt = surf + A.alt;
      if (!A.axis) {
        const sp0 = V3.magnitude(this.v), ref = sp0 > 1 ? this.v : this.f;
        A.axis = A.plane ? new V3(0, 0, 1) : V3.cross(rel, ref, new V3());
        if (V3.magnitude(A.axis) < 1e-6) V3.cross(rel, V3.UNIT_Z, A.axis);
        V3.normalize(A.axis, A.axis);
        const w0 = A.mul * Math.sqrt(B.GM / (rt * rt * rt));
        this.say(A.plane ? `Flying level with the rings${A.zOff ? `, ${fmtD(A.zOff)} above them` : ', right in the gap'}: they stretch out below you and Saturn is off to the side (drag to look round). A lap every ${fmtT(2 * Math.PI / w0)}.`
          : `Cruising in orbit around ${B.name} at ${fmtD(A.alt)}: one lap every ${fmtT(2 * Math.PI / w0)}${A.mul > 1 ? ` (${A.mul}x real speed)` : ''}.`);
      }
      const w = A.mul * Math.sqrt(B.GM / (r * r * r)), th = w * dt, c = Math.cos(th), s = Math.sin(th), ax = A.axis;
      const cr = V3.cross(ax, rel, _ap3), ad = V3.dot(ax, rel);
      const nr = new V3(rel.x * c + cr.x * s + ax.x * ad * (1 - c), rel.y * c + cr.y * s + ax.y * ad * (1 - c), rel.z * c + cr.z * s + ax.z * ad * (1 - c));
      if (A.plane) nr.z += (A.zOff - nr.z) * Math.min(1, dt * 0.8);      // ring-plane runs: settle to the set height over the rings
      const nl = V3.magnitude(nr); V3.multiplyByScalar(nr, (nl + (rt - nl) * Math.min(1, dt * 0.8)) / nl, nr);
      const np = V3.add(B.c, nr, _ap4);
      V3.multiplyByScalar(V3.subtract(np, this.p, _apv), 1 / dt, this.v); V3.clone(np, this.p); moved = true;
      status = `orbiting ${B.name} at ${fmtD(Math.max(0, r - surf))} · a lap every ${fmtT(2 * Math.PI / w)}`;
    }
    if (!moved) {
      V3.add(this.v, V3.multiplyByScalar(V3.subtract(_apv, this.v, _a), Math.min(1, dt * 3), _a), this.v);
      V3.add(this.p, V3.multiplyByScalar(this.v, dt, _t2), this.p);
    }
    // point along the way you are going (not straight up or down), belly toward the nearest body
    this.dE = V3.magnitude(this.p) - R; this.dS = satAlt(this.p);
    // belly toward the nearest body; over the rings, belly toward the ring plane so the rings lie below you like ground
    const ctr = this.dE < this.dS ? AP_BODIES.enc.c : SAT;
    const up = A.plane && A.phase === 'orbit' ? V3.clone(V3.UNIT_Z, _ap1) : V3.normalize(V3.subtract(this.p, ctr, _ap1), _ap1);
    const sp = V3.magnitude(this.v), vr = V3.dot(this.v, up), tang = V3.subtract(this.v, V3.multiplyByScalar(up, vr, _ap2), _ap2), tl = V3.magnitude(tang);
    if (sp > 0.5 && tl > 0.35 * sp) {
      const aim = V3.normalize(comb(_ap3, 1, tang, 0.6, V3.multiplyByScalar(up, vr, _ap4)), _ap3), e = Math.min(1, dt * 3);
      comb(this.f, 1 - e, this.f, e, aim);
    }
    if (Math.abs(V3.dot(V3.normalize(this.f, this.f), up)) < 0.95) V3.clone(up, this.u);
    this.orthonormalize(); this.rates = [0, 0, 0];
    this.space = this.dE > SHIP.maxAlt; this.inSat = V3.distance(this.p, SAT) < SAT_AREA;
    if (!this.space) {
      const c1 = E.cartesianToCartographic(this.p, _carto); this.alt = c1.height - gE - SHIP.leg;
      if (this.alt < 0 && A.phase !== 'land') { this.p = V3.fromRadians(c1.longitude, c1.latitude, gE + SHIP.leg + 1, E, this.p); this.alt = 1; }
    }
    this.landed = false;
    this.mode = sp > 20000 ? 'intra' : sp > 900 ? 'warp' : sp > 150 ? 'turbo' : 'normal';
    const P2 = A.phase;
    this.fwdGlow += ((P2 === 'orbit' || P2 === 'hover' ? 0.15 : Math.min(1, sp / 100)) - this.fwdGlow) * Math.min(1, dt * 4);
    this.upGlow = P2 === 'hover' || P2 === 'land' ? 0.5 : 0.05;
    if (status !== this.apText && (!this._apT || performance.now() - this._apT > 250)) { this._apT = performance.now(); $('apStatus').textContent = A.name + ' · ' + status; }
    this.apText = status;
    this.place();
    for (const b of padBtns) b.classList.toggle('on', false);
  },
});
(function apUI() {
  const sel = $('apDest');
  sel.innerHTML = AP_DESTS.filter(d => !d.group).map(d => `<option value="${d.id}">${d.label}</option>`).join('')
    + '<optgroup label="Named places on Enceladus">' + AP_DESTS.filter(d => d.group).map(d => `<option value="${d.id}">${d.label}</option>`).join('') + '</optgroup>';
  const modeBtns = [...document.querySelectorAll('#apMode button')];
  const setMode = m => { ship.apMode = m; modeBtns.forEach(b => b.classList.toggle('on', b.dataset.m === m)); ship.apSetMode(m); };
  modeBtns.forEach(b => { b.onclick = () => setMode(b.dataset.m); });
  const sync = () => {
    const d = AP_DESTS.find(x => x.id === sel.value), land = modeBtns.find(b => b.dataset.m === 'land');
    land.disabled = d.body === 'sat'; if (land.disabled && ship.apMode === 'land') setMode('orbit');
    if (d.alt) { $('apAlt').value = d.alt; $('apUnit').value = '1000'; }
    $('apNote').textContent = d.id === 'map' ? (ship.apPick ? `Spot picked: ${Math.abs(ship.apPick.lat).toFixed(2)}°${ship.apPick.lat >= 0 ? 'N' : 'S'}, ${Math.abs(ship.apPick.lon).toFixed(2)}°${ship.apPick.lon >= 0 ? 'E' : 'W'}. Click the map again to change it.` : 'Click a spot on the map (top right) to choose it.')
      : d.body === 'sat' ? 'Saturn has no surface to land on: cruise in orbit or hover. Altitude is above the cloud tops.'
      : 'Takes off, flies there and settles in. Altitude is above the ice. Touch any flight control to take over.';
  };
  ship.apAltNow = () => { const v = parseFloat($('apAlt').value); return isFinite(v) && v >= 0 ? v * +$('apUnit').value : null; };
  ship.apSync = sync;
  sel.addEventListener('change', () => { sync(); if (ship.ap) ship.apEngage(); sel.blur(); });
  const altLive = () => { const a = ship.apAltNow(); if (a !== null && ship.ap) ship.ap.alt = ship.ap.body === 'enc' ? Math.max(5, a) : Math.max(500e3, a); };
  $('apAlt').addEventListener('input', altLive); $('apUnit').addEventListener('change', altLive);
  $('apSpeed').addEventListener('change', () => { if (ship.ap) { ship.ap.mul = +$('apSpeed').value; if (ship.ap.phase === 'orbit') ship.ap.axis = ship.ap.axis; } });
  $('apGo').onclick = () => (ship.ap ? ship.apOff('Autopilot off: you have control.') : ship.apEngage());
  $('shipAuto').onclick = () => { const p = $('appanel'); if (p.classList.contains('mini')) p.classList.remove('mini'); else p.classList.toggle('hide'); sync(); };
  $('apClose').onclick = () => $('appanel').classList.add('hide');
  $('apEdit').onclick = () => $('appanel').classList.remove('mini');
  $('apStop').onclick = () => ship.apOff('Autopilot off: you have control.');
  sync(); ship.apUI();
})();

// the on-screen game controls; each button holds one or more keys, so the keyboard lights them up too
const padBtns = [...document.querySelectorAll('#shippad [data-k]')];
// TURBO, WARP and INTRASTELLAR on the pad are gears: tap one to select it (tap again for cruise), then GO flies in that gear.
// The keyboard keeps them as hold keys (Shift, F, J).
ship.gear = null;
const gearBtns = padBtns.filter(b => b.dataset.go);
const setGear = ship.setGear = g => { ship.gear = g; for (const b of gearBtns) b.classList.toggle('sel', b.dataset.k === g);
  ship.say(g ? `Gear: ${MODE_NAME[{ shift: 'turbo', f: 'warp', j: 'intra' }[g]]}. Hold GO to fly in it.` : 'Gear: cruise.'); };
for (const b of padBtns) {
  b._keys = b.dataset.k.split(' ').map(x => x === 'space' ? ' ' : x);
  const k = b._keys[0], gear = !!b.dataset.go, isGo = k === 'w';
  let held = null;   // the gear key GO added while held
  const on = e => { e.preventDefault(); b._down = true;
    if (gear) { setGear(ship.gear === k ? null : k); if (ship.on) ship.hud(); return; }
    walk.keys.add(k); if (isGo && ship.gear) { held = ship.gear; walk.keys.add(held); }
    try { b.setPointerCapture(e.pointerId); } catch (_) {} };
  const off = () => { b._down = false; if (gear) return; walk.keys.delete(k); if (held) { walk.keys.delete(held); held = null; } };
  b.addEventListener('contextmenu', e => e.preventDefault());
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
}
$('chipFly').onclick = () => (walk.on && walk.mode === 'ship' ? walk.exit() : walk.on ? ship.board()
  : walk.picking && walk.pickShip ? walk.cancel() : walk.begin(true));
$('walkShip').onclick = () => ship.board();
$('startSpace').onclick = () => { walk.land(5, 0); if (ship.on) ship.startInSpace(); };
$('shipView').onclick = () => { ship.view = (ship.view + 1) % VIEWS.length; ship.zoom = 1; ship.hud(); };
$('shipOut').onclick = () => ship.disembark();
$('shipRefuel').onclick = () => { ship.fuel = SHIP.prop; ship.say('Tanks full (pretend: there is no fuel depot on Enceladus).'); ship.hud(); };
$('shipExit').onclick = () => walk.exit();
// phones: the ship panel and the map open from two buttons at the top right
const flyPanel = (cls, btn, on) => { document.body.classList.toggle(cls, on); $(btn).setAttribute('aria-pressed', on); };
$('flyMenuBtn').onclick = () => { const on = !document.body.classList.contains('flymenu'); flyPanel('flymenu', 'flyMenuBtn', on); if (on) flyPanel('flymap', 'flyMapBtn', false); };
$('flyMapBtn').onclick = () => { const on = !document.body.classList.contains('flymap'); flyPanel('flymap', 'flyMapBtn', on); if (on) flyPanel('flymenu', 'flyMenuBtn', false); };
for (const id of ['shipAuto', 'shipOut', 'shipExit']) $(id).addEventListener('click', () => flyPanel('flymenu', 'flyMenuBtn', false));
for (const [id, kind] of [['fuelMain', 'main'], ['fuelThr', 'thr']]) {
  const sel = $(id), cur = kind === 'main' ? ship.mainFuel : ship.thrFuel;
  sel.innerHTML = Object.entries(FUELS).map(([k, F]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${F.name}${kind === 'main' ? ` · Isp ${F.isp.toLocaleString('en-US')} s` : ''}</option>`).join('');
  const swatch = () => { const F = FUELS[sel.value]; $(id + 'Sw').style.background = `rgb(${F.rgb.map(x => Math.round(x * 255)).join(',')})`; };
  sel.addEventListener('change', () => { ship.setFuel(kind, sel.value); swatch(); if (ship.on) ship.hud(); sel.blur(); });
  swatch();
}
$('fuelInf').onclick = () => { ship.setInfinite(!ship.infinite); if (ship.on) ship.hud(); };
ship.setInfinite(ship.infinite); ship.msg = '';
cv.addEventListener('wheel', e => {
  if (!walk.on || walk.mode !== 'ship') return;
  e.preventDefault(); ship.zoom = clamp(ship.zoom * Math.exp(e.deltaY * 0.001), 0.3, 40);
}, { passive: false });
// ---------- game controllers: Xbox / PlayStation / Switch pads and flight sticks, through the browser Gamepad API ----------
// Optional: nothing changes until a controller is plugged in (or paired) and a button is pressed, which is when the
// browser first reveals it. Pads with the "standard" layout get a console-style mapping; anything else (most flight
// sticks and HOTAS) gets a stick mapping: X roll, Y pitch, twist yaw, throttle lever for thrust.
const pad = {
  owned: new Set(), prev: [], raf: 0, invert: (() => { try { return localStorage.getItem('encPadInvert') === '1'; } catch (_) { return false; } })(),
  dz(v, z = 0.15) { return Math.abs(v) < z ? 0 : Math.sign(v) * (Math.abs(v) - z) / (1 - z); },
  first() { for (const g of (navigator.getGamepads ? navigator.getGamepads() : [])) if (g && g.connected) return g; return null; },
  press(keys) {      // hold exactly these keys for the controller, leaving keyboard and touch keys alone
    for (const k of this.owned) if (!keys.has(k)) walk.keys.delete(k);
    for (const k of keys) walk.keys.add(k);
    this.owned = keys;
  },
  release() { this.press(new Set()); ship.ax.pitch = ship.ax.yaw = ship.ax.roll = 0; },
  gearStep(d) { const G = [null, 'shift', 'f', 'j'], i = clamp(G.indexOf(ship.gear) + d, 0, 3); ship.setGear(G[i]); if (ship.on) ship.hud(); },
  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    const g = this.first(); if (!g) { this.release(); return; }
    const B = i => { const b = g.buttons[i]; return !!b && (b.pressed || b.value > 0.4); };
    const A = i => g.axes[i] || 0;
    const tap = i => B(i) && !this.prev[i];      // pressed this frame
    const keys = new Set(), std = g.mapping === 'standard';
    const flying = walk.on && walk.mode === 'ship' && ship.on && !ship.crashed;
    if (flying) {
      const inv = this.invert ? -1 : 1;
      if (std) {
        // left stick steers (pull back for nose up, like a plane), right stick rolls; triggers are GO and REV
        ship.ax.yaw = this.dz(A(0)); ship.ax.pitch = this.dz(A(1)) * inv; ship.ax.roll = this.dz(A(2));
        if (B(7)) { keys.add('w'); if (ship.gear) keys.add(ship.gear); }
        if (B(6)) keys.add('s');
        if (B(0) || B(12)) keys.add('r'); if (B(2) || B(13)) keys.add('c'); if (B(1)) keys.add('x');
        if (tap(4)) this.gearStep(-1); if (tap(5)) this.gearStep(1);
        if (tap(3)) $('shipView').click(); if (tap(9)) $('shipAuto').click(); if (tap(8)) $('flyMenuBtn').click();
      } else {
        // flight stick: X roll, Y pitch (push forward for nose down), twist yaw; trigger (or throttle lever forward) is GO
        ship.ax.roll = this.dz(A(0)); ship.ax.pitch = this.dz(A(1)) * inv;
        ship.ax.yaw = g.axes.length > 5 ? this.dz(A(5), 0.25) : g.axes.length > 2 ? this.dz(A(2), 0.25) : 0;
        const lever = g.axes.length > 6 ? A(6) : g.axes.length > 3 ? A(3) : 0;
        if (B(0) || lever < -0.5) { keys.add('w'); if (ship.gear) keys.add(ship.gear); }
        if (B(1)) keys.add('x'); if (B(2)) keys.add('r'); if (B(3)) keys.add('c');
        if (tap(4)) this.gearStep(-1); if (tap(5)) this.gearStep(1);
        if (tap(6)) $('shipView').click(); if (tap(7)) $('shipAuto').click();
      }
    } else {
      ship.ax.pitch = ship.ax.yaw = ship.ax.roll = 0;
      if (walk.on && walk.mode !== 'ship') {      // on the ice: left stick walks, right stick (or stick twist) turns, A jumps
        const x = this.dz(A(0)), y = this.dz(A(1)), t = std ? this.dz(A(2)) : 0;
        if (y < -0.4) keys.add('w'); if (y > 0.4) keys.add('s'); if (x < -0.4) keys.add('a'); if (x > 0.4) keys.add('d');
        if (t < -0.4) keys.add('arrowleft'); if (t > 0.4) keys.add('arrowright');
        if (tap(0)) walk.jump(); if (tap(3)) ship.board();
      } else if (!walk.on && (tap(9) || (!std && tap(0)))) {      // from orbit view: Start (or the trigger) begins a flight in orbit space
        walk.begin(true); walk.land(5, 0); if (ship.on) ship.startInSpace();
      }
    }
    this.press(keys);
    this.prev = g.buttons.map((b, i) => B(i));
  },
};
const invBtn = $('padInvert');
const showInv = () => { invBtn.textContent = pad.invert ? 'Controller pitch: inverted' : 'Controller pitch: like a plane'; invBtn.setAttribute('aria-pressed', pad.invert); };
invBtn.onclick = () => { pad.invert = !pad.invert; try { localStorage.setItem('encPadInvert', pad.invert ? '1' : '0'); } catch (_) {} showInv(); };
showInv();
window.addEventListener('gamepadconnected', e => {
  invBtn.hidden = false;
  const std = e.gamepad.mapping === 'standard', name = e.gamepad.id.replace(/\s*\(.*$/, '').slice(0, 40) || 'Controller';
  ship.say(std ? `${name} connected. Left stick steers, right stick rolls, RT go, LT reverse, A lift, X drop, B brake, LB/RB gear, Y view, Start autopilot.`
    : `${name} connected. Stick: roll and pitch, twist to turn, trigger to go. Buttons 2 brake, 3 lift, 4 drop, 5/6 gear.`);
  if (walk.on && ship.on) ship.hud();
  if (!pad.raf) pad.loop();
});
window.addEventListener('gamepaddisconnected', () => { if (!pad.first()) { cancelAnimationFrame(pad.raf); pad.raf = 0; pad.release(); invBtn.hidden = true; } });
