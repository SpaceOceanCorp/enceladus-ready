// ---------- rover ops: plan and run a rover traverse on the real terrain, with Earth contact windows and signal delay ----------
// Real: ground heights and slopes (the level-5 terrain tiles from the Schenk & McKinnon 2024 DEM, about 390 m apart), the
// tiger-stripe positions (a line drawn through the Porco et al. 2014 jet sources of each stripe), Earth's place in the sky and
// the one-way light time (JPL Horizons), Earth rising and setting, and Saturn blocking Earth once an orbit.
// Illustrative: the rover itself (no Enceladus rover is planned), its speed and power, the slope limit, the no-go band along
// the stripes, the slower ground near jets and the science-interest score.
// Route planning (A*) and self-picked targets follow the ideas in ajmcastro/space-mission-control-center (MIT licence).
const rover = (() => {
  const D = Math.PI / 180, N = 48, CELL = 400, HALF = (N - 1) / 2;
  const LIMIT = 25, SPEED = 120, MASK = 5;                      // slope limit (deg), drive speed (m/h), antenna horizon (deg)
  const RTG = 110, HOUSE = 60, DRIVE = 200, SAMPLE_W = 150, BATT = 2400, SAMPLE_MS = 2 * 3600e3;   // watts, watt-hours
  const LOW = 0.3, FULL = 0.95, STRIPE_NOGO = 1000, FALLOUT = 1500, AUTO_MAX = 2;
  // Earth seen from Enceladus: JPL Horizons, target 602, observer 500@399 (geocentric), quantities 14 and 21, every 5 days
  // from 2026-11-01 00:00 UTC. Columns: sub-Earth west longitude (deg), sub-Earth latitude (deg), one-way light time (min).
  const EARTH_T0 = Date.UTC(2026, 10, 1), EARTH_STEP = 5 * 86400e3, ROT = 360 / 1.370218;  // Enceladus spin, deg per day
  const EARTH = [
    [119.173,  -7.038,  71.09], [353.05,  -6.898,  71.47], [226.891,  -6.791,  71.86], [100.663,  -6.697,  72.34],
    [334.426,  -6.612,  72.86], [208.135,  -6.559,  73.39], [81.78,  -6.529,  73.99], [315.414,  -6.511,  74.61],
    [188.983,  -6.518,  75.23], [62.498,  -6.555,  75.91], [296.0,  -6.608,  76.58], [169.433,  -6.678,  77.25],
    [42.826,  -6.776,  77.96], [276.206,  -6.898,  78.64], [149.517,  -7.028,  79.31], [22.804,  -7.18,  80.01],
    [256.076,  -7.361,  80.65], [129.287,  -7.547,  81.28], [2.491,  -7.742,  81.91], [235.675,  -7.969,  82.47],
    [108.81,  -8.202,  83.03], [341.951,  -8.433,  83.57], [215.071,  -8.691,  84.02], [88.156,  -8.958,  84.47],
    [321.258,  -9.218,  84.88], [194.335,  -9.491,  85.21], [67.394,  -9.778,  85.53], [300.477,  -10.06,  85.79],
    [173.535,  -10.338,  85.98], [46.592,  -10.629,  86.15], [279.675,  -10.923,  86.25], [152.735,  -11.2,  86.29],
    [25.81,  -11.48,  86.32], [258.912,  -11.774,  86.25], [131.994,  -12.045,  86.15], [5.108,  -12.304,  86.02],
    [238.243,  -12.583,  85.8], [111.368,  -12.843,  85.55], [344.536,  -13.077,  85.27], [217.721,  -13.326,  84.91],
    [90.906,  -13.566,  84.53], [324.144,  -13.774,  84.12], [197.394,  -13.982,  83.63], [70.657,  -14.191,  83.14],
    [303.979,  -14.372,  82.61], [177.309,  -14.534,  82.02], [50.666,  -14.698,  81.45], [284.083,  -14.848,  80.82],
    [157.506,  -14.963,  80.17], [30.971,  -15.073,  79.53], [264.493,  -15.185,  78.85], [138.021,  -15.255,  78.16],
    [11.604,  -15.305,  77.49], [245.238,  -15.368,  76.78], [118.878,  -15.395,  76.1], [352.585,  -15.387,  75.44],
    [226.331,  -15.394,  74.75], [100.088,  -15.375,  74.11], [333.915,  -15.316,  73.49], [207.767,  -15.263,  72.87],
    [81.633,  -15.199,  72.32], [315.567,  -15.098,  71.79], [189.509,  -14.988,  71.28], [63.467,  -14.88,  70.85],
    [297.483,  -14.749,  70.45], [171.488,  -14.596,  70.08], [45.508,  -14.449,  69.81], [279.569,  -14.301,  69.57],
    [153.6,  -14.125,  69.39], [27.642,  -13.954,  69.3], [261.701,  -13.802,  69.24], [135.713,  -13.628,  69.26],
    [9.732,  -13.452,  69.36], [243.742,  -13.312,  69.49], [117.691,  -13.163,  69.7], [351.641,  -13.008,  69.99],
    [225.557,  -12.895,  70.29], [99.406,  -12.789,  70.69], [333.251,  -12.679,  71.13], [207.04,  -12.604,  71.59],
    [80.765,  -12.554,  72.13], [314.479,  -12.505,  72.7], [188.125,  -12.481,  73.28], [61.715,  -12.489,  73.93],
    [295.29,  -12.511,  74.57], [168.79,  -12.542,  75.22],
  ];
  // Saturn stays put in Enceladus's sky (sub-Saturn point from the Horizons lighting table, about 4.4 W) and is about
  // 14.2 degrees in radius as seen from there, so Earth is hidden whenever it is that close to Saturn's centre.
  const SAT_LON = -4.4, SAT_RAD = 14.2;
  const wrap = a => (((a % 360) + 540) % 360) - 180;
  const unit = (la, lo) => [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const m = Math.hypot(a[0], a[1], a[2]); return [a[0] / m, a[1] / m, a[2] / m]; };
  const SAT = unit(0, SAT_LON * D), SAT_COS = Math.cos(SAT_RAD * D);

  function earthAt(t) {
    const f = (t - EARTH_T0) / EARTH_STEP, n = EARTH.length;
    const k = Math.max(0, Math.min(n - 2, Math.floor(f))), u = f - k, uc = Math.max(0, Math.min(1, u));
    const a = EARTH[k], b = EARTH[k + 1], res = wrap(b[0] - a[0] - ROT * 5);
    const wl = a[0] + ROT * 5 * u + res * uc;
    return { lat: a[1] + (b[1] - a[1]) * uc, lon: wrap(-wl), lt: (a[2] + (b[2] - a[2]) * uc) * 60e3, approx: u < 0 || u > 1 };
  }
  function view(t, la, lo) {   // la, lo in degrees
    const e = earthAt(t), d = unit(e.lat * D, e.lon * D);
    const el = Math.asin(Math.max(-1, Math.min(1, dot(unit(la * D, lo * D), d)))) / D, behind = dot(d, SAT) > SAT_COS;
    return { el, behind, ok: el >= MASK && !behind, lt: e.lt, approx: e.approx };
  }
  function nextFlip(t, la, lo, ok, maxMs) {
    for (let s = 5 * 60e3; s <= maxMs; s += 5 * 60e3) if (view(t + s, la, lo).ok !== ok) return t + s;
    return null;
  }
  const firstOk = (t, la, lo) => (view(t, la, lo).ok ? t : nextFlip(t, la, lo, false, 12 * 86400e3));

  // ---- heights from the terrain tiles the globe already uses (level 5, 65 x 65 int16, radius minus R) ----
  const S = 180 / 32, tiles = new Map();
  const tkey = (la, lo) => [Math.min(63, Math.max(0, Math.floor((lo + 180) / S))), Math.min(31, Math.max(0, Math.floor((90 - la) / S)))];
  function hAt(la, lo) {
    const [x, y] = tkey(la, lo), a = tiles.get(x + '/' + y); if (!a) return null;
    const u = Math.min(64, Math.max(0, (lo + 180 - x * S) / S * 64)), v = Math.min(64, Math.max(0, (90 - y * S - la) / S * 64));
    const i0 = Math.min(63, Math.floor(u)), j0 = Math.min(63, Math.floor(v)), tu = u - i0, tv = v - j0, g = (i, j) => a[j * 65 + i];
    return (g(i0, j0) * (1 - tu) + g(i0 + 1, j0) * tu) * (1 - tv) + (g(i0, j0 + 1) * (1 - tu) + g(i0 + 1, j0 + 1) * tu) * tv;
  }
  // height above the reference ellipsoid: slopes are measured against it, a close stand-in for level ground
  const zAt = (la, lo) => { const h = hAt(la, lo); return h === null ? 0 : R + h - ellR(la * D, lo * D); };

  // ---- a flat east/north frame centred on the work area ----
  let F = null;
  function makeFrame(la0, lo0, h0) {
    const la = la0 * D, lo = lo0 * D;
    return { la0, lo0, u: unit(la, lo), e: [-Math.sin(lo), Math.cos(lo), 0], n: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)], Rl: R + h0 };
  }
  function toLL(x, y) {
    const p = [0, 1, 2].map(k => F.u[k] * F.Rl + F.e[k] * x + F.n[k] * y), r = Math.hypot(p[0], p[1], p[2]);
    return [Math.asin(p[2] / r) / D, Math.atan2(p[1], p[0]) / D];
  }
  function toXY(v) { const t = dot(v, F.u); return t <= 0.5 ? null : [F.Rl * dot(v, F.e) / t, F.Rl * dot(v, F.n) / t]; }
  const cellXY = k => [(k % N - HALF) * CELL, (((k / N) | 0) - HALF) * CELL];
  const cellOf = (x, y) => { const i = Math.round(x / CELL + HALF), j = Math.round(y / CELL + HALF); return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i; };

  // ---- tiger-stripe traces: each stripe's jet sources in order along the stripe ----
  let traces = null;
  function buildTraces() {
    const by = {};
    for (const j of jets || []) if (j.sulcus) (by[j.sulcus] = by[j.sulcus] || []).push(unit(j.lat * D, j.lon * D));
    traces = [];
    for (const [name, vs] of Object.entries(by)) {
      if (vs.length < 3) continue;
      const c = norm(vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]));
      const e1 = norm(cross(Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], c)), e2 = cross(c, e1);
      const pts = vs.map(v => [dot(v, e1), dot(v, e2), v]);
      let sxx = 0, syy = 0, sxy = 0; pts.forEach(p => { sxx += p[0] * p[0]; syy += p[1] * p[1]; sxy += p[0] * p[1]; });
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = Math.cos(ang), ay = Math.sin(ang);
      pts.sort((p, q) => (p[0] * ax + p[1] * ay) - (q[0] * ax + q[1] * ay));
      // Chain each jet to its nearest unvisited neighbour, starting from one end. Some stripes have jets on two
      // parallel lines, so a gap wider than CHAIN_GAP starts a new line instead of zig-zagging between them.
      const left = pts.slice(), CHAIN_GAP = 9000 / R;
      while (left.length) {
        let cur = left.shift(); const line = [cur[2]];
        for (;;) {
          let bi = -1, bd = Infinity;
          left.forEach((p, i) => { const d = Math.hypot(p[0] - cur[0], p[1] - cur[1]); if (d < bd) { bd = d; bi = i; } });
          if (bi < 0 || bd > CHAIN_GAP) break;
          cur = left.splice(bi, 1)[0]; line.push(cur[2]);
        }
        if (line.length > 1) traces.push({ name, pts: line });
      }
    }
  }
  function segDist(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L)) : 0;
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  }

  // ---- the work area: a 48 x 48 grid of 400 m cells ----
  let G = null;
  async function buildGrid(la0, lo0) {
    if (!traces) buildTraces();
    F = makeFrame(la0, lo0, 0);
    const need = new Set(), ext = (HALF + 2) * CELL;
    for (let y = -ext; y <= ext; y += CELL / 2) for (let x = -ext; x <= ext; x += CELL / 2) { const [la, lo] = toLL(x, y); need.add(tkey(la, lo).join('/')); }
    await Promise.all([...need].map(async k => { if (!tiles.has(k)) { const [x, y] = k.split('/').map(Number); tiles.set(k, await loadT(x, y, 5)); } }));
    F = makeFrame(la0, lo0, hAt(la0, lo0) || 0);
    const n = N * N;
    G = { lat: new Float64Array(n), lon: new Float64Array(n), h: new Float32Array(n), slope: new Float32Array(n), dJet: new Float32Array(n),
      jet: new Array(n), dStr: new Float32Array(n), stripe: new Array(n), why: new Uint8Array(n), mult: new Float32Array(n), sci: new Float32Array(n) };
    const jl = (jets || []).map(j => ({ j, p: toXY(unit(j.lat * D, j.lon * D)) })).filter(o => o.p);
    const segs = [];
    for (const tr of traces) for (let k = 0; k + 1 < tr.pts.length; k++) { const a = toXY(tr.pts[k]), b = toXY(tr.pts[k + 1]); if (a && b) segs.push([a, b, tr.name]); }
    G.segs = segs;
    for (let k = 0; k < n; k++) {
      const [x, y] = cellXY(k), [la, lo] = toLL(x, y);
      G.lat[k] = la; G.lon[k] = lo; G.h[k] = hAt(la, lo) || 0;
      const z = (dx, dy) => { const [a, b] = toLL(x + dx, y + dy); return zAt(a, b); };
      const gx = (z(CELL / 2, 0) - z(-CELL / 2, 0)) / CELL, gy = (z(0, CELL / 2) - z(0, -CELL / 2)) / CELL;
      G.slope[k] = Math.atan(Math.hypot(gx, gy)) / D;
      let dj = Infinity, jn = null; for (const o of jl) { const d = Math.hypot(x - o.p[0], y - o.p[1]); if (d < dj) { dj = d; jn = o.j; } }
      let ds = Infinity, sn = null; for (const s of segs) { const d = segDist(x, y, s[0], s[1]); if (d < ds) { ds = d; sn = s[2]; } }
      G.dJet[k] = dj; G.jet[k] = jn; G.dStr[k] = ds; G.stripe[k] = sn;
      G.why[k] = ds < STRIPE_NOGO ? 1 : G.slope[k] > LIMIT ? 2 : 0;
      G.mult[k] = (1 + 2 * (G.slope[k] / LIMIT) ** 2) * (dj < FALLOUT ? 1.5 : 1);
      G.sci[k] = G.why[k] ? 0 : Math.min(10, 7 * Math.exp(-dj / 3000) + 3 * Math.exp(-Math.max(0, ds - STRIPE_NOGO) / 2000) + 1.5 * Math.min(1, G.slope[k] / 12));
    }
  }

  // ---- A* over the grid, 8 neighbours, no corner cutting past a no-go cell ----
  function astar(s, g) {
    if (s < 0 || g < 0 || G.why[g]) return null;
    const n = N * N, gs = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), closed = new Uint8Array(n), heap = [];
    const push = (f, i) => { heap.push([f, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } }
      return top;
    };
    const gi = g % N, gj = (g / N) | 0, hh = i => Math.hypot(i % N - gi, ((i / N) | 0) - gj) * CELL;
    gs[s] = 0; push(hh(s), s);
    while (heap.length) {
      const c = pop()[1]; if (closed[c]) continue; closed[c] = 1; if (c === g) break;
      const ci = c % N, cj = (c / N) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const k = nj * N + ni; if (G.why[k] || closed[k]) continue;
        if (di && dj && (G.why[cj * N + ni] || G.why[nj * N + ci])) continue;
        const ng = gs[c] + (di && dj ? Math.SQRT2 : 1) * CELL * (G.mult[c] + G.mult[k]) / 2;
        if (ng < gs[k]) { gs[k] = ng; from[k] = c; push(ng + hh(k), k); }
      }
    }
    if (!closed[g]) return null;
    const path = [g]; while (path[path.length - 1] !== s) path.push(from[path[path.length - 1]]);
    return path.reverse();
  }
  const segLen = (a, b) => (a % N !== b % N && ((a / N) | 0) !== ((b / N) | 0) ? Math.SQRT2 : 1) * CELL;
  const speedOn = k => SPEED * (G.slope[k] > 10 ? 0.6 : 1);
  function pathStats(path) {
    let m = 0, h = 0; for (let i = 1; i < path.length; i++) { const L = segLen(path[i - 1], path[i]); m += L; h += L / speedOn(path[i]); }
    return { m, h };
  }

  // ---- simulation state ----
  let on = false, picking = false, adding = true, speed = 6, mapMode = 'cost', sim = null, src = null, pts = null, savedEx = null, lastHud = 0;
  let draft = [];   // targets the ground is planning, not yet sent
  const fmtT = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const dur = ms => { const m = Math.round(Math.abs(ms) / 60e3); return m < 60 ? m + ' min' : m < 48 * 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min' : (m / 1440).toFixed(1) + ' days'; };
  const llText = (la, lo) => `${Math.abs(la).toFixed(2)}°${la >= 0 ? 'N' : 'S'}, ${Math.abs(lo).toFixed(2)}°${lo >= 0 ? 'E' : 'W'}`;

  function newSim(start) {
    const t = Date.now();
    return { t0: t, t, cell: start, route: [], ri: 0, prog: 0, state: 'idle', batt: BATT * 0.9, odo: 0, sampleLeft: 0, queue: [], current: null,
      reached: [], auto: 0, log: [], snaps: [], uplinks: [], minBatt: 0.9, okMs: 0, gapStart: null, gapMax: 0, lastSnap: 0, flip: null, sent: 0 };
  }
  function log(text) { sim.log.push({ t: sim.t, text }); if (sim.log.length > 200) sim.log.shift(); renderLog(); }
  function roverXY() {
    const s = sim;
    if (s.state === 'driving' && s.ri + 1 < s.route.length) {
      const a = cellXY(s.route[s.ri]), b = cellXY(s.route[s.ri + 1]), f = s.prog / segLen(s.route[s.ri], s.route[s.ri + 1]);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    return cellXY(s.cell);
  }
  function roverLL() { const [x, y] = roverXY(); return toLL(x, y); }

  function describe(k) {
    const bits = [];
    if (G.jet[k] && G.dJet[k] < 6000) bits.push(`${(G.dJet[k] / 1000).toFixed(1)} km from ${G.jet[k].name || G.jet[k].id} on ${G.jet[k].sulcus} Sulcus`);
    else if (G.stripe[k] && G.dStr[k] < 8000) bits.push(`${(G.dStr[k] / 1000).toFixed(1)} km from ${G.stripe[k]} Sulcus`);
    bits.push(`slope ${G.slope[k].toFixed(0)}°`, `science interest ${G.sci[k].toFixed(1)}/10`);
    return bits.join(', ');
  }
  function nextLeg() {
    const s = sim;
    s.route = []; s.ri = 0; s.prog = 0;
    while (s.queue.length) {
      const t = s.queue.shift(), path = astar(s.cell, t.cell);
      if (!path) { log(`No safe route to ${t.label}; skipped it.`); continue; }
      s.current = t; s.route = path;
      if (path.length < 2) { arrive(); return; }
      s.state = s.batt < LOW * BATT ? 'charging' : 'driving';
      log(`Driving to ${t.label}: ${(pathStats(path).m / 1000).toFixed(1)} km by the planned route.`);
      return;
    }
    s.current = null;
    if ($('roverAuto').checked && s.auto < AUTO_MAX) {
      const k = aegis();
      if (k !== null) {
        s.auto++;
        const t = { cell: k, label: `own pick ${s.auto}`, auto: true };
        log(`No targets left and no new plan, so the rover picked its own: ${describe(k)}.`);
        s.queue.push(t); drawTargets(); nextLeg(); return;
      }
    }
    s.state = 'idle'; log('Plan finished. Waiting for the next plan from Earth.');
  }
  function arrive() {
    const s = sim, t = s.current;
    s.state = 'sampling'; s.sampleLeft = SAMPLE_MS; s.route = []; s.ri = 0; s.prog = 0;
    t.reachedAt = s.t; s.reached.push(t);
    log(`Reached ${t.label}${s.stops ? ` after ${s.stops} recharging stop${s.stops === 1 ? '' : 's'}` : ''}. Imaging and sampling the surface (2 h).`); s.stops = 0;
    drawTargets();
  }
  function aegis() {
    const s = sim, ci = s.cell % N, cj = (s.cell / N) | 0;
    const near = k => s.reached.some(t => Math.hypot(t.cell % N - k % N, ((t.cell / N) | 0) - ((k / N) | 0)) * CELL < 1200);
    let best = null, bs = -Infinity;
    for (let k = 0; k < N * N; k++) {
      if (G.why[k]) continue;
      const d = Math.hypot(k % N - ci, ((k / N) | 0) - cj) * CELL; if (d > 3000 || d < 600 || near(k)) continue;
      const sc = G.sci[k] - d / 3000; if (sc > bs) { bs = sc; best = k; }
    }
    return best !== null && astar(s.cell, best) ? best : null;
  }
  function acceptPlan(u) {
    const s = sim;
    if (s.state === 'driving' && s.ri + 1 < s.route.length && s.prog > segLen(s.route[s.ri], s.route[s.ri + 1]) / 2) s.cell = s.route[s.ri + 1];
    s.queue = u.targets.map(t => ({ ...t })); s.auto = 0; u.live = s.queue.slice();
    log(`New plan received from Earth (${u.targets.length} target${u.targets.length === 1 ? '' : 's'}). Replanning the route on board from where the rover is now.`);
    const wasCharging = s.state === 'charging', wasSampling = s.state === 'sampling';
    if (wasSampling) return;   // finish the sample first; the queue is picked up afterwards
    nextLeg();
    if (wasCharging && s.state === 'driving') s.state = 'charging';
    drawTargets();
  }
  function step(dt) {
    const s = sim; s.t += dt;
    for (const u of s.uplinks) if (!u.done && s.t >= u.arrive) { u.done = true; acceptPlan(u); }
    const hrs = dt / 3600e3; let draw = HOUSE;
    if (s.state === 'driving') {
      draw += DRIVE;
      let d = speedOn(s.route[Math.min(s.ri + 1, s.route.length - 1)]) * hrs;
      while (d > 0 && s.ri + 1 < s.route.length) {
        const L = segLen(s.route[s.ri], s.route[s.ri + 1]), use = Math.min(d, L - s.prog);
        s.prog += use; s.odo += use; d -= use;
        if (s.prog >= L - 1e-6) { s.ri++; s.cell = s.route[s.ri]; s.prog = 0; G.trail.push(s.cell); trailDirty = true; }
      }
      if (s.ri + 1 >= s.route.length) arrive();
    } else if (s.state === 'sampling') {
      draw += SAMPLE_W; s.sampleLeft -= dt;
      if (s.sampleLeft <= 0) { log(`Finished at ${s.current.label}.`); nextLeg(); }
    }
    s.batt = Math.min(BATT, s.batt + (RTG - draw) * hrs);
    s.minBatt = Math.min(s.minBatt, s.batt / BATT);
    if (s.state === 'driving' && s.batt < LOW * BATT) { s.state = 'charging'; s.stops = (s.stops || 0) + 1; if (s.stops === 1) log('Battery down to 30%. Parked to let the RTG recharge it (about a day and a half each time).'); }
    if (s.state === 'charging' && s.batt >= FULL * BATT) s.state = s.ri + 1 < s.route.length ? 'driving' : 'idle';
    const [la, lo] = roverLL(), v = view(s.t, la, lo);
    if (v.ok) { s.okMs += dt; if (s.gapStart !== null) { s.gapMax = Math.max(s.gapMax, s.t - s.gapStart); s.gapStart = null; } }
    else if (s.gapStart === null) s.gapStart = s.t;
    if (s.t - s.lastSnap >= 15 * 60e3) {
      s.lastSnap = s.t; s.snaps.push({ t: s.t, la, lo, batt: s.batt, state: s.state, ok: v.ok });
      const heard = lastHeardIndex(); if (heard > 0) s.snaps.splice(0, heard);
    }
  }
  function lastHeardIndex() {
    const s = sim, lt = earthAt(s.t).lt;
    for (let i = s.snaps.length - 1; i >= 0; i--) if (s.snaps[i].ok && s.snaps[i].t <= s.t - lt) return i;
    return -1;
  }
  // where the ground thinks the rover is: its last report that has had time to reach Earth
  function groundCell() {
    const i = lastHeardIndex(); if (i < 0) return sim.cell;
    const p = sim.snaps[i], xy = toXY(unit(p.la * D, p.lo * D)), k = xy ? cellOf(xy[0], xy[1]) : -1;
    return k < 0 || G.why[k] ? sim.cell : k;
  }

  // ---- drawing ----
  let ents = null, trailDirty = false;
  const hpos = (k, up = 30) => C.Cartesian3.fromDegrees(G.lon[k], G.lat[k], G.h[k] * scene.verticalExaggeration + up, E);
  const xyPos = (x, y, up = 30) => { const [la, lo] = toLL(x, y), h = hAt(la, lo) || 0; return C.Cartesian3.fromDegrees(lo, la, h * scene.verticalExaggeration + up, E); };
  function colorOf(k) {
    if (mapMode === 'sci') {
      if (G.why[k]) return C.Color.fromCssColorString('#555a66').withAlpha(0.55);
      const f = G.sci[k] / 10; return new C.Color(0.12 + 0.7 * f, 0.35 + 0.6 * f, 0.75 + 0.25 * f, 0.5 + 0.4 * f);
    }
    if (G.why[k] === 1) return C.Color.fromCssColorString('#ff4d4d').withAlpha(0.9);
    if (G.why[k] === 2) return C.Color.fromCssColorString('#ff9a3c').withAlpha(0.9);
    if (G.dJet[k] < FALLOUT) return C.Color.fromCssColorString('#c792ea').withAlpha(0.85);
    const f = Math.min(1, G.slope[k] / LIMIT);
    return new C.Color(0.34 + 0.57 * f, 0.78 + 0.1 * f, 0.52 - 0.1 * f, 0.6);
  }
  function drawMap() {
    if (pts) { scene.primitives.remove(pts); pts = null; }
    if (mapMode === 'off') { $('roverLegend').innerHTML = ''; return; }
    pts = scene.primitives.add(new C.PointPrimitiveCollection());
    for (let k = 0; k < N * N; k++) pts.add({ position: hpos(k, 12), pixelSize: 6, color: colorOf(k), disableDepthTestDistance: 2e5 });
    $('roverLegend').innerHTML = mapMode === 'sci'
      ? '<span><i style="background:#2b5fd0"></i>Low</span><span><i style="background:#9ef0ff"></i>High science interest (illustrative)</span><span><i style="background:#555a66"></i>No-go</span>'
      : `<span><i style="background:#57c785"></i>Easy</span><span><i style="background:#e8e26a"></i>Steeper</span><span><i style="background:#c792ea"></i>Near a jet: slower</span><span><i style="background:#ff9a3c"></i>Over ${LIMIT}°</span><span><i style="background:#ff4d4d"></i>Tiger-stripe fracture</span>`;
  }
  function drawStatic() {
    src.entities.removeAll();
    const e = HALF * CELL + CELL / 2, ring = [];
    for (const [ax, ay, bx, by] of [[-e, -e, e, -e], [e, -e, e, e], [e, e, -e, e], [-e, e, -e, -e]]) for (let f = 0; f < 1; f += 1 / 24) ring.push(xyPos(ax + (bx - ax) * f, ay + (by - ay) * f, 60));
    ring.push(ring[0]);
    src.entities.add({ polyline: { positions: ring, width: 2, material: C.Color.fromCssColorString('#8ab4f8').withAlpha(0.9), depthFailMaterial: C.Color.fromCssColorString('#8ab4f8').withAlpha(0.3), arcType: C.ArcType.NONE } });
    // stripe traces inside the area, densified along the ground
    const lim = e + CELL;
    for (const [a, b] of G.segs) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(2, Math.ceil(L / 200)), line = [];
      for (let i = 0; i <= n; i++) { const x = a[0] + (b[0] - a[0]) * i / n, y = a[1] + (b[1] - a[1]) * i / n; if (Math.abs(x) < lim && Math.abs(y) < lim) line.push(xyPos(x, y, 40)); else if (line.length > 1) break; }
      if (line.length > 1) src.entities.add({ polyline: { positions: line, width: 3, material: C.Color.fromCssColorString('#7ee2ff').withAlpha(0.95), depthFailMaterial: C.Color.fromCssColorString('#7ee2ff').withAlpha(0.35), arcType: C.ArcType.NONE } });
    }
    ents = {
      rover: src.entities.add({ position: hpos(sim.cell, 40), point: { pixelSize: 15, color: C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#0b1220'), outlineWidth: 3, disableDepthTestDistance: Infinity },
        label: { text: 'Rover', font: '600 13px Inter, sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -18), disableDepthTestDistance: Infinity } }),
      ghost: src.entities.add({ show: false, position: hpos(sim.cell, 40), point: { pixelSize: 15, color: C.Color.TRANSPARENT, outlineColor: C.Color.fromCssColorString('#7ee2ff'), outlineWidth: 2.5, disableDepthTestDistance: Infinity },
        label: { text: 'Last heard on Earth', font: '500 12px Inter, sans-serif', fillColor: C.Color.fromCssColorString('#7ee2ff'), outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, 20), disableDepthTestDistance: Infinity } }),
      trail: src.entities.add({ polyline: { positions: [], width: 3, material: C.Color.WHITE.withAlpha(0.85), arcType: C.ArcType.NONE } }),
      route: src.entities.add({ polyline: { positions: [], width: 4, material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString('#ffd36b'), dashLength: 14 }), arcType: C.ArcType.NONE } }),
      preview: src.entities.add({ polyline: { positions: [], width: 4, material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString('#8ab4f8'), dashLength: 10 }), arcType: C.ArcType.NONE } }),
      targets: [],
    };
    G.trail = [sim.cell];
  }
  function drawTargets() {
    if (!ents) return;
    ents.targets.forEach(t => src.entities.remove(t)); ents.targets = [];
    const add = (k, text, css) => ents.targets.push(src.entities.add({ position: hpos(k, 45),
      point: { pixelSize: 11, color: C.Color.fromCssColorString(css), outlineColor: C.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Infinity },
      label: { text, font: '600 12px Inter, sans-serif', fillColor: C.Color.fromCssColorString(css), outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -15), disableDepthTestDistance: Infinity } }));
    draft.forEach((t, i) => add(t.cell, 'Draft ' + (i + 1), '#8ab4f8'));
    sim.queue.forEach(t => add(t.cell, t.label, '#ffd36b'));
    if (sim.current && sim.state !== 'sampling') add(sim.current.cell, sim.current.label, '#ffd36b');
    sim.reached.forEach(t => add(t.cell, '✓ ' + t.label, '#57c785'));
    for (const u of sim.uplinks) if (!u.done) u.targets.forEach(t => add(t.cell, t.label + ' (on its way)', '#e9edf3'));
    drawPreview(); renderPlan();
  }
  let previewInfo = null;
  function drawPreview() {
    previewInfo = null;
    if (!draft.length) { ents.preview.polyline.positions = []; return; }
    let at = groundCell(), all = [], m = 0, h = 0; const bad = [];
    for (const t of draft) {
      const p = astar(at, t.cell); if (!p) { bad.push(t.label); continue; }
      const st = pathStats(p); m += st.m; h += st.h; all = all.concat(all.length ? p.slice(1) : p); at = t.cell;
    }
    ents.preview.polyline.positions = all.map(k => hpos(k, 35));
    // RTG rovers drive in bursts: the battery drains at about 150 W while driving and refills at about 50 W when parked
    const burst = (FULL - LOW) * BATT / (DRIVE + HOUSE - RTG), refill = (FULL - LOW) * BATT / (RTG - HOUSE);
    const total = h + Math.floor(h / burst) * refill + draft.length * 2;
    previewInfo = { m, h, total, bad };
  }
  function drawRoute() {
    const s = sim;
    ents.route.polyline.positions = s.route.length > 1 ? s.route.slice(s.ri).map(k => hpos(k, 35)) : [];
  }

  // ---- panel ----
  function renderPlan() {
    const list = $('roverTargets');
    list.innerHTML = draft.map((t, i) => `<li>${esc(t.label)} <span class="cite">${esc(describe(t.cell))}</span> <button class="lnk" data-del="${i}" aria-label="Remove">✕</button></li>`).join('')
      || '<li class="cite" style="list-style:none;margin-left:-18px">No draft targets yet.</li>';
    list.querySelectorAll('[data-del]').forEach(b => { b.onclick = () => { draft.splice(+b.dataset.del, 1); draft.forEach((t, i) => { t.label = 'target ' + (sim.sent + i + 1); }); drawTargets(); }; });
    const p = previewInfo;
    $('roverPlanSum').textContent = !p ? '' : `${(p.m / 1000).toFixed(1)} km of driving, about ${Math.round(p.h)} h at the wheel and roughly ${dur(p.total * 3600e3)} including stops to recharge and 2 h at each target.` + (p.bad.length ? ` No safe route to ${p.bad.join(', ')}.` : '');
    $('roverSend').disabled = !draft.length;
  }
  function renderLog() {
    $('roverLog').innerHTML = sim.log.slice(-14).reverse().map(e => `<li><span class="cite">${fmtT(e.t).slice(5, 16)}</span> ${esc(e.text)}</li>`).join('');
  }
  const STATE = { idle: 'parked, waiting for a plan', driving: 'driving', sampling: 'imaging and sampling', charging: 'parked, recharging from the RTG' };
  function hud() {
    const s = sim, [la, lo] = roverLL(), v = view(s.t, la, lo);
    $('roverTime').textContent = `${fmtT(s.t)} · mission day ${((s.t - s.t0) / 86400e3).toFixed(1)}`;
    if (!s.flip || s.t >= s.flip.at || s.flip.ok !== v.ok) s.flip = { ok: v.ok, at: nextFlip(s.t, la, lo, v.ok, 6 * 86400e3) || Infinity };
    const when = s.flip.at === Infinity ? 'not within 6 days' : 'in ' + dur(s.flip.at - s.t);
    $('roverEarth').innerHTML = v.ok ? `<b class="ok">In contact</b>, Earth ${v.el.toFixed(1)}° up · contact ends ${when}`
      : `<b class="no">No contact</b>: ${v.behind ? 'Earth is behind Saturn' : v.el < 0 ? 'Earth is below the horizon' : `Earth is only ${v.el.toFixed(1)}° up`} · back ${when}`;
    $('roverLT').textContent = `${(v.lt / 60e3).toFixed(1)} min each way` + (v.approx ? ' (outside the Horizons table, approximate)' : '');
    $('roverState').textContent = STATE[s.state] + (s.current && s.state !== 'idle' ? ` (${s.current.label})` : '');
    $('roverBatt').textContent = `${Math.round(100 * s.batt / BATT)}%`;
    $('roverOdo').textContent = `${(s.odo / 1000).toFixed(2)} km · ${s.reached.length} target${s.reached.length === 1 ? '' : 's'} reached`;
    const i = lastHeardIndex();
    $('roverHeard').textContent = i < 0 ? 'nothing yet' : `${dur(s.t - s.snaps[i].t)} ago (${STATE[s.snaps[i].state]}, battery ${Math.round(100 * s.snaps[i].batt / BATT)}%)`;
    const up = s.uplinks.filter(u => !u.done);
    $('roverUplink').textContent = up.length ? `Plan on its way: reaches the rover ${fmtT(up[0].arrive).slice(5)} (in ${dur(up[0].arrive - s.t)}).` : '';
    document.querySelectorAll('#roverSpeed button').forEach(b => b.classList.toggle('on', +b.dataset.s === speed));
  }
  function frame(now) {
    if (!on || !sim) return;
    const dtReal = Math.min(0.1, (now - (frame.last || now)) / 1000); frame.last = now;
    let left = speed * 3600e3 * dtReal;
    while (left > 0) { const d = Math.min(left, 5 * 60e3); step(d); left -= d; }
    if (speed || !ents.rover._placed) {
      const [x, y] = roverXY(); ents.rover.position = xyPos(x, y, 40); ents.rover._placed = true;
      const i = lastHeardIndex();
      if (i >= 0) { const p = sim.snaps[i], dx = toXY(unit(p.la * D, p.lo * D)); ents.ghost.position = xyPos(dx[0], dx[1], 40); }
      ents.ghost.show = i >= 0 && Math.hypot(...toXY(unit(sim.snaps[i].la * D, sim.snaps[i].lo * D)).map((q, j) => q - roverXY()[j])) > 150;
      if (trailDirty) { ents.trail.polyline.positions = G.trail.map(k => hpos(k, 32)); trailDirty = false; }
      drawRoute();
    }
    if (now - lastHud > 200) { lastHud = now; hud(); if (sim._targetsDirty !== sim.reached.length + sim.queue.length) { sim._targetsDirty = sim.reached.length + sim.queue.length; drawTargets(); } }
  }

  // ---- actions ----
  function addTarget(k) {
    if (k < 0) { flash('That spot is outside the work area.'); return; }
    if (G.why[k]) { flash(G.why[k] === 1 ? 'That spot is on a tiger-stripe fracture, a no-go zone.' : `That ground is steeper than ${LIMIT}°, too steep for the rover.`); return; }
    if (draft.length >= 8) { flash('Up to 8 targets per plan.'); return; }
    draft.push({ cell: k, label: 'target ' + (sim.sent + draft.length + 1) }); drawTargets();
  }
  function flash(text) { const el = $('roverFlash'); el.textContent = text; el.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => el.classList.remove('show'), 3500); }
  function suggest() {
    const picks = [], from = groundCell();
    const order = [...Array(N * N).keys()].filter(k => !G.why[k]).sort((a, b) => G.sci[b] - G.sci[a]);
    for (const k of order) {
      if (picks.length >= 4) break;
      if (picks.some(p => Math.hypot(p % N - k % N, ((p / N) | 0) - ((k / N) | 0)) * CELL < 2500)) continue;
      const far = Math.hypot(from % N - k % N, ((from / N) | 0) - ((k / N) | 0)) * CELL;
      if (far < 800 || far > 6000) continue;   // keep suggestions within a few days' drive
      if (astar(from, k)) picks.push(k);
    }
    // visit them nearest-first
    let at = from; draft = [];
    while (picks.length) {
      let bi = 0, bd = Infinity; picks.forEach((p, i) => { const d = Math.hypot(p % N - at % N, ((p / N) | 0) - ((at / N) | 0)); if (d < bd) { bd = d; bi = i; } });
      at = picks.splice(bi, 1)[0]; draft.push({ cell: at, label: 'target ' + (sim.sent + draft.length + 1) });
    }
    drawTargets();
  }
  function send() {
    if (!draft.length) return;
    const s = sim, [la, lo] = roverLL(), lt = earthAt(s.t).lt, arrive = firstOk(s.t + lt, la, lo);
    if (arrive === null) { flash('The rover has no contact with Earth in the next 12 days from here.'); return; }
    s.uplinks.push({ sentAt: s.t, arrive, targets: draft.map(t => ({ ...t })) });
    s.sent += draft.length;
    log(`Plan sent from Earth (${draft.length} target${draft.length === 1 ? '' : 's'}). Light time ${(lt / 60e3).toFixed(0)} min; it reaches the rover ${fmtT(arrive).slice(5)}${arrive - s.t > lt + 60e3 ? ', the first time the rover can hear Earth after the signal gets there' : ''}.`);
    draft = []; drawTargets();
  }
  function summary() {
    const s = sim, days = (s.t - s.t0) / 86400e3, el = s.t - s.t0;
    const gap = Math.max(s.gapMax, s.gapStart !== null ? s.t - s.gapStart : 0);
    const own = s.reached.filter(t => t.auto).length;
    const text = [
      `Work area centred at ${llText(F.la0, F.lo0)}, ${(N * CELL / 1000).toFixed(1)} km across.`,
      `${days.toFixed(1)} mission days (${(el / (1.370218 * 86400e3)).toFixed(1)} Enceladus days). The rover drove ${(s.odo / 1000).toFixed(2)} km and reached ${s.reached.length} target${s.reached.length === 1 ? '' : 's'}${own ? `, ${own} of them picked by itself` : ''}.`,
      `Earth was in contact ${el ? Math.round(100 * s.okMs / el) : 0}% of the time. The longest stretch without contact was ${dur(gap)}. Each message took about ${(earthAt(s.t).lt / 60e3).toFixed(0)} minutes one way.`,
      `The battery never fell below ${Math.round(100 * s.minBatt)}%. ${s.uplinks.length} plan${s.uplinks.length === 1 ? ' was' : 's were'} sent from Earth.`,
    ];
    $('roverSumText').innerHTML = text.map(t => `<p>${esc(t)}</p>`).join('') + '<p class="cite">Written from the simulation\'s own record by fixed rules. No AI is involved.</p>';
  }

  // ---- open and close ----
  function begin() {
    if (typeof life !== 'undefined' && life.on) life.close();
    if (walk.on) walk.exit(); if (inside.on) inside.close(); if (dive.picking) dive.cancel(); if (walk.picking) walk.cancel();
    if (section.picking || section.isOpen()) section.stop();
    picking = true; $('roverhint').classList.add('open'); $('chipRover').classList.add('on');
  }
  function cancel() { picking = false; $('roverhint').classList.remove('open'); if (!on) $('chipRover').classList.remove('on'); }
  function pickArea(pos) {
    const ray = camera.getPickRay(pos), p = ray && (globe.pick(ray, scene) || camera.pickEllipsoid(pos, E)); if (!p) return;
    const c = E.cartesianToCartographic(p); open(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude));
  }
  async function open(la, lo) {
    cancel(); $('roverhint').classList.remove('open'); $('chipRover').classList.add('on');
    $('roverpanel').classList.remove('hide'); $('icepanel').classList.add('hide'); $('roverBody').classList.add('hide'); $('roverLoading').classList.remove('hide');
    if (!on) { savedEx = scene.verticalExaggeration; exag.disabled = true; }
    on = true; document.body.classList.add('roverops');
    try { await buildGrid(la, lo); } catch (err) { console.error(err); $('roverLoading').textContent = 'The terrain for this area could not load.'; return; }
    let start = cellOf(0, 0);
    if (G.why[start]) { let best = -1, bd = Infinity; for (let k = 0; k < N * N; k++) if (!G.why[k]) { const d = Math.hypot(k % N - HALF, ((k / N) | 0) - HALF); if (d < bd) { bd = d; best = k; } } start = best; }
    sim = newSim(start); draft = [];
    if (!src) { src = new C.CustomDataSource('rover'); viewer.dataSources.add(src); }
    drawStatic(); drawMap(); drawTargets(); renderLog();
    const v = view(sim.t, G.lat[start], G.lon[start]);
    log(`Rover set down at ${llText(G.lat[start], G.lon[start])}. ` + (v.ok ? 'Earth is in view.' : 'Earth is out of view right now.'));
    $('roverArea').textContent = `Work area ${(N * CELL / 1000).toFixed(1)} km across at ${llText(la, lo)}, in ${N} × ${N} cells of ${CELL} m, the spacing of the height data.`;
    $('roverLoading').classList.add('hide'); $('roverBody').classList.remove('hide'); $('roverSumText').innerHTML = '';
    const target = C.Cartesian3.fromDegrees(lo, la, (hAt(la, lo) || 0) * scene.verticalExaggeration, E);
    camera.flyToBoundingSphere(new C.BoundingSphere(target, 1), { offset: new C.HeadingPitchRange(0, -55 * D, 34e3), duration: 2 });
    hud();
  }
  function close() {
    if (!on) return;
    on = false; sim = null; G = null; draft = []; ents = null;
    if (pts) { scene.primitives.remove(pts); pts = null; }
    if (src) src.entities.removeAll();
    exag.disabled = false; if (savedEx !== null) { scene.verticalExaggeration = savedEx; savedEx = null; }
    document.body.classList.remove('roverops');
    $('roverpanel').classList.add('hide'); $('chipRover').classList.remove('on'); if (ice.on) $('icepanel').classList.remove('hide');
  }
  function click(pos) {
    if (!adding || !G) return;
    const ray = camera.getPickRay(pos), p = ray && globe.pick(ray, scene); if (!p) return;
    const c = E.cartesianToCartographic(p), xy = toXY(unit(c.latitude, c.longitude));
    addTarget(xy ? cellOf(xy[0], xy[1]) : -1);
  }

  scene.preRender.addEventListener(() => frame(performance.now()));
  $('chipRover').onclick = () => (on ? close() : picking ? cancel() : begin());
  $('roverCancel').onclick = cancel;
  $('roverStripes').onclick = () => open(-81.2, -28);   // between Baghdad and Damascus sulci, among the jets
  $('roverClose').onclick = close;
  $('roverMove').onclick = () => { close(); begin(); };
  $('roverSuggest').onclick = suggest;
  $('roverClear').onclick = () => { draft = []; drawTargets(); };
  $('roverSend').onclick = send;
  $('roverSummary').onclick = summary;
  document.querySelectorAll('#roverSpeed button').forEach(b => { b.onclick = () => { speed = +b.dataset.s; hud(); }; });
  document.querySelectorAll('#roverMap button').forEach(b => { b.onclick = () => { mapMode = b.dataset.m; document.querySelectorAll('#roverMap button').forEach(x => x.classList.toggle('on', x === b)); drawMap(); }; });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') { if (picking) cancel(); else if (on) close(); } });
  // _advance steps the simulation without drawing frames (for tests and a hidden tab)
  const _advance = ms => { for (let left = ms; left > 0; left -= 5 * 60e3) step(Math.min(left, 5 * 60e3)); hud(); };
  return { get on() { return on; }, get picking() { return picking; }, pickArea, click, close, open, _advance, _state: () => ({ sim, G, draft, F }) };
})();
