// ---------- inside Saturn's rings: the ice particles themselves, around the ship ----------
// Near the ring plane over the main rings, the ship is surrounded by individual particles drawn at true scale.
// How many, and how big, comes from the same Cassini data as the ring texture (saturn_rings.py):
// - optical depth tau at each radius: the UVIS Beta Centauri occultation, read back from the texture's alpha
//   (alpha = 1 - exp(-tau), so tau = -ln(1 - alpha))
// - sizes: the standard power law n(r) ~ r^-3 from 1 cm to 5 m (French & Nicholson 2000), so every size decade
//   holds the same share of tau. Three bands are drawn: 1-5 m boulders, 20 cm - 1 m rocks, 5-20 cm pebbles;
//   anything smaller is the haze.
// - vertical spread: a Gaussian about the ring plane, sigma ~3 m in the C ring, ~7 m in the B ring, ~5 m in the
//   Cassini Division and ~10 m in the A ring (the rings are only some 10 m thick; these are rounded estimates).
// From these: column number density N = tau * f / (pi <r^2>) per band, and density at height z is
// N * gauss(z, sigma). Particles are placed by a seeded random draw per grid cell, so the same spot always holds
// the same particles. They orbit with the ring at the local circular speed; near the plane the ship matches that
// orbit (globe_fly.js, ringFrame), so you drift among them at your own flying speed. The mean free path
// lambda = sqrt(2 pi) sigma / tau sets how far you can see inside the layer: a few metres in the B ring, which
// the haze shows, and the flat ring picture gets a hole cut around you so the real particles show through.
const ringField = (() => {
  const N = 8192, R0 = 74500e3, R1 = 140220e3, LNTOT = Math.log(5 / 0.01);
  // how far out each size is drawn (beyond that, a pebble is a pixel or less and belongs to the haze)
  const BANDS = [{ r1: 1, r2: 5, S: 25, Rmax: 120 }, { r1: 0.2, r2: 1, S: 5, Rmax: 25 }, { r1: 0.05, r2: 0.2, S: 2, Rmax: 8 }]
    .map(b => ({ ...b, f: Math.log(b.r2 / b.r1) / LNTOT, mr2: Math.log(b.r2 / b.r1) / ((b.r1 ** -2 - b.r2 ** -2) / 2), cells: new Map(), key: '' }));
  const HZ = 2.5;      // vertical cell size, metres
  let tau = null, rgb = null, coll = null, sprites = null, active = false;
  const off = new C.Cartesian3(), _q = new C.Cartesian3(), _w = new C.Cartesian3(), _vk = new C.Cartesian3();
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = N; c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 1, N, 1, 0, 0, N, 1);
    const d = g.getImageData(0, 0, N, 1).data; tau = new Float32Array(N); rgb = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = d[i * 4 + 3] / 255; tau[i] = a >= 0.995 ? 5 : -Math.log(1 - a);
      for (let k = 0; k < 3; k++) rgb[i * 3 + k] = d[i * 4 + k] / 255;
    }
  };
  img.src = 'saturn-ring.png';
  const idx = r => Math.min(N - 1, Math.max(0, Math.floor((r - R0) / (R1 - R0) * N)));
  const sigma = r => r < 91980e3 ? 3 : r < 117580e3 ? 7 : r < 122050e3 ? 5 : 10;
  const region = r => r < 74500e3 ? null : r < 91980e3 ? 'C ring' : r < 117580e3 ? 'B ring' : r < 122050e3 ? 'Cassini Division'
    : r < 136775e3 ? 'A ring' : r < 139500e3 ? 'gap outside the A ring' : r < 140700e3 ? 'F ring' : null;
  // small seeded random generator per cell, so a spot always holds the same particles
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const hash = (a, b, c, d) => { let h = 2166136261; for (const v of [a, b, c, d]) { h ^= v & 0xffff; h = Math.imul(h, 16777619); h ^= v >>> 16; h = Math.imul(h, 16777619); } return h; };
  const poisson = (lam, R) => { if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(6.2832 * R()))); let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= R(); } while (p > L); return k - 1; };
  function makeSprites() {      // a few lumpy, icy chunks lit from one side
    return [0, 1, 2, 3].map(v => {
      const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), R = rng(1000 + v);
      g.beginPath(); const n = 9 + v;
      for (let i = 0; i <= n; i++) { const a = i / n * 6.2832, rr = 22 + 8 * R(); g.lineTo(32 + rr * Math.cos(a), 32 + rr * Math.sin(a)); }
      const gr = g.createRadialGradient(24, 22, 3, 32, 32, 34); gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.55, '#d9dde2'); gr.addColorStop(1, '#6f747c');
      g.fillStyle = gr; g.fill();
      for (let i = 0; i < 5; i++) { g.fillStyle = `rgba(90,95,105,${0.15 + 0.2 * R()})`; g.beginPath(); g.arc(20 + 28 * R(), 20 + 28 * R(), 2 + 4 * R(), 0, 6.2832); g.fill(); }
      return c.toDataURL();
    });
  }
  function clearBand(b) { for (const list of b.cells.values()) for (const p of list) coll.remove(p.bb); b.cells.clear(); b.key = ''; }
  function clearAll() { if (coll) for (const b of BANDS) clearBand(b); C.Cartesian3.clone(C.Cartesian3.ZERO, off); }
  // particles for one grid cell (in the ring's co-orbiting frame), or an empty list
  function fill(b, ix, iy, iz) {
    const cx = (ix + 0.5) * b.S, cy = (iy + 0.5) * b.S, z0 = iz * HZ;
    const wx = cx + off.x, wy = cy + off.y, r = Math.hypot(wx - SATURN_D, wy);
    if (r < R0 || r > R1) return [];
    const i = idx(r), t = tau[i], s = sigma(r); if (t < 0.002) return [];
    const zc = z0 + HZ / 2, dens = t * b.f / (Math.PI * b.mr2) * Math.exp(-zc * zc / (2 * s * s)) / (Math.sqrt(2 * Math.PI) * s);
    const R = rng(hash(ix, iy, iz, b.r1 * 100)), n = poisson(dens * b.S * b.S * HZ, R), out = [];
    const tint = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]], lum = Math.max(0.2, (tint[0] + tint[1] + tint[2]) / 3);
    for (let k = 0; k < Math.min(n, 60); k++) {
      const u = R(), rad = Math.pow(b.r1 ** -2 - u * (b.r1 ** -2 - b.r2 ** -2), -0.5);      // size from r^-3
      const q = new C.Cartesian3(ix * b.S + R() * b.S, iy * b.S + R() * b.S, z0 + R() * HZ), sh = 0.7 + 0.3 * R();
      const col = new C.Color(Math.min(1, tint[0] / lum * sh), Math.min(1, tint[1] / lum * sh), Math.min(1, tint[2] / lum * sh), 1);
      out.push({ q, bb: coll.add({ position: C.Cartesian3.add(q, off, new C.Cartesian3()), image: sprites[Math.floor(R() * 4)], width: 2 * rad, height: 2 * rad,
        sizeInMeters: true, color: col, rotation: R() * 6.2832 }) });
    }
    return out;
  }
  function updateBand(b, qShip, rS, t, s, R) {
    const ix0 = Math.floor(qShip.x / b.S), iy0 = Math.floor(qShip.y / b.S), cr = Math.ceil(R / b.S), zr = Math.ceil(3 * s / HZ);
    const key = `${ix0},${iy0},${cr},${zr},${Math.floor(qShip.z / HZ)}`;
    if (key === b.key) return; b.key = key;
    const want = new Set();
    for (let dx = -cr; dx <= cr; dx++) for (let dy = -cr; dy <= cr; dy++) {
      if ((dx * dx + dy * dy) * b.S * b.S > (R + b.S) * (R + b.S)) continue;
      for (let iz = -zr; iz < zr; iz++) want.add(`${ix0 + dx},${iy0 + dy},${iz}`);
    }
    for (const [k, list] of b.cells) if (!want.has(k)) { for (const p of list) coll.remove(p.bb); b.cells.delete(k); }
    for (const k of want) if (!b.cells.has(k)) { const [x, y, z] = k.split(',').map(Number); b.cells.set(k, fill(b, x, y, z)); }
  }
  const haze = () => $('ringhaze');
  return {
    tau: r => (tau ? tau[idx(r)] : 0), sigma, region,
    // called every frame while flying (after the ship has moved)
    update(dt) {
      const S = ship, p = S.p, x = p.x - SATURN_D, rho = Math.hypot(x, p.y), az = Math.abs(p.z);
      const on = tau && walk.on && walk.mode === 'ship' && S.on && !S.crashed && S.space && rho > R0 && rho < R1 && az < 400;
      const hz = haze();
      if (!on) {
        if (active) { clearAll(); active = false; hz.style.opacity = 0; if (skyObjs && skyObjs.rings) skyObjs.rings.appearance.material.uniforms.holeR = 0; }
        if (az > 5000 || rho < R0 || rho > R1) C.Cartesian3.clone(C.Cartesian3.ZERO, off);
        return;
      }
      if (!coll) { coll = scene.primitives.add(new C.BillboardCollection({ scene })); sprites = makeSprites(); }
      active = true;
      // the particles orbit at the local circular speed (prograde, about Saturn's pole = +z)
      const vk = Math.sqrt(GM_SAT / rho); _vk.x = -p.y / rho * vk; _vk.y = x / rho * vk; _vk.z = 0;
      C.Cartesian3.add(off, C.Cartesian3.multiplyByScalar(_vk, dt, _w), off);
      C.Cartesian3.subtract(p, off, _q);
      const i = idx(rho), t = tau[i], s = sigma(rho), mfp = Math.sqrt(2 * Math.PI) * s / Math.max(t, 1e-3);
      let reach = 0;
      // each size band is drawn out to a few mean free paths, within a budget of ~1,000 particles (the dense B ring
      // would otherwise need tens of thousands of pebbles; past them the haze stands in)
      for (const b of BANDS) {
        const ncol = Math.max(t, 1e-3) * b.f / (Math.PI * b.mr2);
        // cells reach about R + S from the ship, so the budget counts that whole disc; too dense a band is left to the haze
        const R = Math.min(b.Rmax, 6 * mfp, Math.sqrt(1000 / (Math.PI * ncol)) - b.S);
        if (R <= 0) { if (b.cells.size) clearBand(b); continue; }
        reach = Math.max(reach, R); updateBand(b, _q, rho, t, s, R);
      }
      for (const b of BANDS) for (const list of b.cells.values()) for (const pt of list) pt.bb.position = C.Cartesian3.add(pt.q, off, _w);
      // the flat ring picture: a hole around you, where the real particles take over
      if (skyObjs && skyObjs.rings) skyObjs.rings.appearance.material.uniforms.holeR = reach * 0.9 / SKY_K;
      // inside the layer, the countless smaller grains (and everything past the drawn particles) are a haze
      const g = Math.exp(-p.z * p.z / (2 * s * s)), op = Math.min(0.92, (1 - Math.exp(-t * g * 1.5)));
      hz.style.opacity = op.toFixed(3);
      hz.style.background = `rgb(${Math.round(rgb[i * 3] * 150)},${Math.round(rgb[i * 3 + 1] * 150)},${Math.round(rgb[i * 3 + 2] * 150)})`;
    },
    // a line for the ship panel, or null when not near the rings
    status(p) {
      const x = p.x - SATURN_D, rho = Math.hypot(x, p.y), name = region(rho), az = Math.abs(p.z);
      if (!name || az > 5000) return null;
      const s = sigma(rho), t = this.tau(rho);
      const where = az < 2 * s ? `Inside the ${name}` : `${fmtD(az)} ${p.z > 0 ? 'north' : 'south'} of the ${name}`;
      return `${where} · optical depth ${t.toFixed(2)}${az < 2 * s ? `, you can see about ${fmtD(Math.sqrt(2 * Math.PI) * s / Math.max(t, 1e-3))}` : ''}`;
    },
  };
})();
// ringField.update runs from walk.frame, right after the ship moves, with the same time step (globe_walk.js)
