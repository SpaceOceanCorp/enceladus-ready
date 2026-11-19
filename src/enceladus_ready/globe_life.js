// ---------- life detection: run the Orbilander's proposed Life Detection Suite on plume fallout ----------
// Every probability, instrument, sample cost and threshold here comes from sisl/LifeDetection
// (https://github.com/sisl/LifeDetection, Stanford SISL with NASA Ames; Kim et al. 2025, arXiv:2510.08812):
//   src/bayes_net.jl            the life prior and how likely each reading is with and without life
//   src/common/bayes_net_helpers.jl  how the Beta curves are cut into bins (bin midpoints, then normalised)
//   src/LifeDetectionPOMDP.jl   the instruments, which readings each returns, sample used, tank size, fallout rate
//   src/common/simulate.jl      the mission's baseline sequence (ConOps) and its 0.999 / 0.001 decision thresholds
// That repository has no licence, so nothing is copied from its code: the model is rebuilt here from those numbers.
// Two differences, both stated in the panel: whether life is present is fixed for the whole landing (the repo
// redraws it with every new batch of fallout), and "Suggest" uses a one-step lookahead, not the paper's SARSOP policy.
const life = (() => {
  const REPO = 'https://github.com/sisl/LifeDetection/blob/main/';
  // --- src/LifeDetectionPOMDP.jl ---
  const TANK = 500, FALL_MEAN = 270, FALL_SD = 0.25 * 270, STEP_CAP = 200;
  const INST = [
    { id: 'hrms', name: 'HRMS', what: 'mass spectrometer: organic compounds', cost: 1, vars: ['o5', 'o7', 'o8', 'o10'] },
    { id: 'sms', name: 'SMS', what: 'amino acid and lipid characterisation', cost: 6, vars: ['o5', 'o6'] },
    { id: 'uce', name: 'μCE-LIF', what: 'amino acids and lipids', cost: 1, vars: ['o5', 'o6'] },
    { id: 'esa', name: 'ESA', what: 'macro- and micronutrients', cost: 3, vars: ['o7', 'o8'] },
    { id: 'mic', name: 'Microscope', what: 'cell-like membranes, autofluorescence', cost: 1, vars: ['o2', 'o3'] },
    { id: 'nano', name: 'Nanopore', what: 'charged chain molecules', cost: 89, vars: ['o1'] },
  ];
  // --- src/common/simulate.jl ---
  const HI = 0.999, LO = 0.001;
  // --- src/bayes_net.jl ---
  const PRIOR = 0.1;
  const beta = (a, b, bins, lo = 0, hi = 1) => {   // bayes_net_helpers.jl DiscreteBeta: pdf at bin midpoints, normalised
    const p = []; for (let i = 0; i < bins; i++) { const x = (i + 0.5) / bins; p.push(Math.pow(x, a - 1) * Math.pow(1 - x, b - 1)); }
    const s = p.reduce((q, r) => q + r, 0); return p.map(v => v / s);
  };
  const joint = (a, b) => { const p = a.map((v, i) => v * b[i]), s = p.reduce((q, r) => q + r, 0); return p.map(v => v / s); };
  const CPD = {
    o1: [[0.95, 0.05], [0.15, 0.85]],     // polyelectrolyte | no life, life
    o2: [[0.95, 0.05], [0.2, 0.8]],       // cell membrane
    o3: [[0.95, 0.05], [0.1, 0.9]],       // autofluorescence
    o4: [beta(2, 13, 5), beta(2, 4, 5)],  // molecular assembly index >= 15
    o5: [beta(1, 10, 23), beta(3, 1, 23)],            // biotic amino acid diversity, 0-22
    o6: [beta(3, 3, 10), beta(0.25, 0.25, 10)],       // L:R chirality
    o7: [beta(1, 1, 5), beta(1.05, 1, 5)],            // salinity | cell membrane no, yes
  };
  const O8 = [];   // CHNOPS | molecular assembly bin i, amino acid bin j
  for (let i = 0; i < 5; i++) { O8.push([]); for (let j = 0; j < 23; j++) O8[i].push(joint(beta(1 + i * 0.1, 1.5, 5), beta(1 + j * 0.001, 1, 5))); }
  const O10 = []; for (let j = 0; j < 23; j++) O10.push(beta(3, 10 - 7 * j / 22, 10));   // redox potential | amino acid bin
  const SIZE = { o1: 2, o2: 2, o3: 2, o4: 5, o5: 23, o6: 10, o7: 5, o8: 5, o10: 10 };
  const NEED = { o7: ['o2'], o8: ['o4', 'o5'], o10: ['o5'] };   // hidden parents to sum over when they are not measured
  function pr(v, a, s) {   // P(variable v takes a[v] | its parents in assignment a, life state s)
    if (v === 'o7') return CPD.o7[a.o2][a.o7];
    if (v === 'o8') return O8[a.o4][a.o5][a.o8];
    if (v === 'o10') return O10[a.o5][a.o10];
    return CPD[v][s][a[v]];
  }
  // For each instrument, every possible combination of readings with its probability without (L0) and with (L1) life.
  let TABLES = null;
  function buildTables() {
    TABLES = INST.map(ins => {
      const obs = ins.vars, hidden = [...new Set(obs.flatMap(v => NEED[v] || []))].filter(v => !obs.includes(v));
      const rows = [], a = {};
      const each = (vars, i, fn) => { if (i === vars.length) return fn(); for (let k = 0; k < SIZE[vars[i]]; k++) { a[vars[i]] = k; each(vars, i + 1, fn); } };
      each(obs, 0, () => {
        const L = [0, 0];
        for (let s = 0; s < 2; s++) each(hidden, 0, () => { let p = 1; for (const v of [...obs, ...hidden]) p *= pr(v, a, s); L[s] += p; });
        rows.push({ vals: obs.map(v => a[v]), L0: L[0], L1: L[1] });
      });
      for (let s = 0; s < 2; s++) { let c = 0; rows.forEach(r => { c += s ? r.L1 : r.L0; r['c' + s] = c; }); }
      return rows;
    });
  }
  const H = p => (p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)));
  const post = (b, r) => (b * r.L1) / (b * r.L1 + (1 - b) * r.L0);
  function infoGain(i, b) {   // expected drop in uncertainty about life (bits) from one run of instrument i
    let g = H(b); for (const r of TABLES[i]) { const p = b * r.L1 + (1 - b) * r.L0; if (p > 0) g -= p * H(post(b, r)); }
    return g;
  }
  function sampleRow(i, s) { const rows = TABLES[i], u = Math.random() * rows[rows.length - 1]['c' + s]; let lo = 0, hi = rows.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m]['c' + s] < u) lo = m + 1; else hi = m; } return rows[lo]; }
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const fallout = () => Math.max(0, Math.round(FALL_MEAN + FALL_SD * gauss()));

  // ---- the two strategies, as pure functions of (state) so the comparison can run without the page ----
  // ConOps, as in conops_orbiter() in src/common/simulate.jl: collect until there is enough for instruments 1-5,
  // run them in order, collect again; declare once confidence passes 0.999 or 0.001. The nanopore is never used.
  function conops(st) {
    if (st.b >= HI) return 'life'; if (st.b <= LO) return 'none';
    if (st.modeAcc) { if (INST.slice(0, 5).reduce((s, x) => s + x.cost, 0) > st.vol) return 'collect'; st.modeAcc = false; st.prev = 1; return 0; }
    if (st.prev < 5 && INST[st.prev].cost < st.vol) { st.prev++; return st.prev - 1; }
    st.modeAcc = true; st.prev = 0; return 'collect';
  }
  // One-step lookahead (ours, not the paper's): run the affordable instrument expected to teach the most; collect if none is affordable.
  function lookahead(st) {
    if (st.b >= HI) return 'life'; if (st.b <= LO) return 'none';
    let best = -1, bg = 1e-9; INST.forEach((x, i) => { if (x.cost <= st.vol) { const g = infoGain(i, st.b); if (g > bg) { bg = g; best = i; } } });
    return best < 0 ? 'collect' : best;
  }
  function apply(st, act, truth) {   // returns the reading row for instruments
    st.steps++;
    if (act === 'collect') { const f = fallout(); st.vol = Math.min(TANK, st.vol + f); return { f }; }
    if (act === 'life' || act === 'none') { st.done = act; return null; }
    const ins = INST[act]; st.vol -= ins.cost; st.used += ins.cost;
    const r = sampleRow(act, truth); st.b = post(st.b, r); return { r };
  }
  const fresh = () => ({ b: PRIOR, vol: 0, used: 0, steps: 0, modeAcc: true, prev: 0, done: null });

  // ---- page state ----
  let on = false, picking = false, st = null, truth = 0, truthMode = 'random', auto = null, src = null, site = null, log = [];
  const pct = p => (p > 0.99995 ? '>99.99%' : p < 0.00005 ? '<0.01%' : p < 0.01 || p > 0.99 ? (100 * p).toFixed(2) + '%' : Math.round(100 * p) + '%');
  const VAL = {
    o1: k => `charged chain molecules (polyelectrolytes): ${k ? 'found' : 'none'}`,
    o2: k => `cell-like membranes: ${k ? 'seen' : 'not seen'}`,
    o3: k => `autofluorescence: ${k ? 'yes' : 'no'}`,
    o5: k => `amino acid diversity: about ${Math.round((k + 0.5) * 22 / 23)} of 22`,
    o6: k => `left-handed share (chirality): ${((k + 0.5) / 10).toFixed(2)}`,
    o7: k => `salinity: ${((k + 0.5) / 5).toFixed(1)} on a 0–1 scale`,
    o8: k => `CHNOPS elements: ${((k + 0.5) / 5).toFixed(1)} on a 0–1 scale`,
    o10: k => `redox potential: ${(-0.5 + (k + 0.5) * 0.05).toFixed(3)} V`,
  };
  const times = f => (f >= 1e6 ? 'over a million times' : '×' + (f < 100 ? f.toFixed(1) : Math.round(f).toLocaleString()));
  function evidence(r) {
    const f = r.L1 / r.L0;
    if (f > 1.15) return `<b class="up">Points toward life ${times(f)}</b>`;
    if (f < 1 / 1.15) return `<b class="down">Points away from life ${times(1 / f)}</b>`;
    return '<span class="cite">Tells little either way</span>';
  }
  function act(a, quiet) {
    if (!st || st.done) return;
    if (typeof a === 'number' && INST[a].cost > st.vol) return;
    const before = st.b, res = apply(st, a, truth);
    if (a === 'collect') log.push(`<b>Collected fallout:</b> +${res.f} units (tank ${st.vol} of ${TANK}).`);
    else if (res && res.r) {
      const ins = INST[a];
      log.push(`<b>${ins.name}</b> (${ins.cost} unit${ins.cost === 1 ? '' : 's'}): ${ins.vars.map((v, i) => VAL[v](res.r.vals[i])).join('; ')}. ${evidence(res.r)}. Chance of life ${pct(before)} → ${pct(st.b)}.`);
    } else if (st.done) finish();
    if (!quiet) render();
  }
  function finish() {
    stop();
    const said = st.done === 'life', right = said === !!truth;
    log.push(`<b>Declared: ${said ? 'life' : 'no life'}.</b> The sample ${truth ? 'did contain life' : 'had no life'}, so the call was <b class="${right ? 'up' : 'down'}">${right ? 'right' : 'wrong'}</b>. ${st.steps - 1} step${st.steps === 2 ? '' : 's'}, ${st.used} unit${st.used === 1 ? '' : 's'} of sample used.`);
  }
  function suggestion() {
    if (!st || st.done) return '';
    const a = lookahead({ ...st });
    if (a === 'life' || a === 'none') return `Confidence has passed the repo's ${a === 'life' ? '99.9%' : '0.1%'} threshold: declare ${a === 'life' ? 'life' : 'no life'}.`;
    if (a === 'collect') return 'Not enough sample for any instrument: collect fallout.';
    return `Run ${INST[a].name}: expected to tell you the most right now (${infoGain(a, st.b).toFixed(2)} bits).`;
  }
  function render() {
    if (!st) return;
    $('lifeTank').style.width = (100 * st.vol / TANK) + '%'; $('lifeTankV').textContent = `${st.vol} of ${TANK} units`;
    $('lifeBel').style.width = (100 * st.b) + '%'; $('lifeBelV').textContent = pct(st.b);
    INST.forEach((x, i) => { const b = $('lifeI' + i); b.disabled = !!st.done || x.cost > st.vol; });
    $('lifeCollect').disabled = !!st.done || st.vol >= TANK; $('lifeYes').disabled = $('lifeNo').disabled = !!st.done;
    $('lifeSuggest').textContent = suggestion();
    $('lifeLog').innerHTML = log.slice(-30).reverse().map(t => `<li>${t}</li>`).join('');
    $('lifeAutoStop').disabled = !auto; $('lifeAutoC').disabled = $('lifeAutoL').disabled = !!auto || !!st.done;
    $('lifeStatus').textContent = st.done ? 'Finished. Press "New sample" to start again.' : `Step ${st.steps} · ${st.used} units used so far`;
  }
  function newRun() {
    stop();
    truth = truthMode === 'life' ? 1 : truthMode === 'none' ? 0 : Math.random() < PRIOR ? 1 : 0;
    st = fresh(); log = [`New sample. Starting chance of life: ${pct(PRIOR)} (the repo's prior). Tank empty.`];
    render();
  }
  function run(kind) {
    stop();
    const pol = kind === 'conops' ? conops : lookahead;
    if (kind === 'conops') { st.modeAcc = true; st.prev = 0; }
    log.push(`<i>Running ${kind === 'conops' ? 'the ConOps baseline' : 'the one-step lookahead'} automatically…</i>`);
    auto = setInterval(() => { if (!st || st.done || st.steps >= STEP_CAP) { if (st && !st.done) { act(st.b >= 0.5 ? 'life' : 'none'); } stop(); return; } act(pol(st)); }, 450);
    render();
  }
  function stop() { if (auto) { clearInterval(auto); auto = null; if (st) render(); } }
  // ---- compare both strategies over many landings ----
  async function compare() {
    const n = 500, res = { conops: [0, 0, 0, 0], lookahead: [0, 0, 0, 0] };   // wrong, steps, sample, false negatives
    $('lifeCmp').innerHTML = '<p class="cite">Running 500 landings with each strategy…</p>';
    for (let k = 0; k < n; k++) {
      const t = Math.random() < PRIOR ? 1 : 0;
      for (const [name, pol] of [['conops', conops], ['lookahead', lookahead]]) {
        const s = fresh();
        while (!s.done && s.steps < STEP_CAP) apply(s, pol(s), t);
        if (!s.done) s.done = s.b >= 0.5 ? 'life' : 'none';
        const said = s.done === 'life';
        if (said !== !!t) { res[name][0]++; if (t) res[name][3]++; }
        res[name][1] += s.steps; res[name][2] += s.used;
      }
      if (k % 25 === 24) await new Promise(r => setTimeout(r, 0));
    }
    const row = (lab, r) => `<tr><td>${lab}</td><td>${(100 * r[0] / n).toFixed(1)}%</td><td>${(r[1] / n).toFixed(1)}</td><td>${(r[2] / n).toFixed(0)}</td></tr>`;
    $('lifeCmp').innerHTML = `<table><tr><th></th><th>Wrong calls</th><th>Steps</th><th>Sample used</th></tr>${row('ConOps baseline', res.conops)}${row('One-step lookahead', res.lookahead)}</table>
      <p class="cite">${n} random landings each, life in about ${Math.round(PRIOR * 100)}% of them as the repo's prior says. Results vary run to run. With the repo's numbers a single HRMS or SMS run usually settles the question, so both strategies are rarely wrong here. The paper's error rates come from a harder test: life redrawn with each batch of fallout, readings drawn from a separate continuous test model, and uneven fallout. There its SARSOP policy (not run here) cut identification errors by nearly 40% against ConOps.</p>`;
  }

  // ---- open and close, and the lander on the globe ----
  function begin() {
    if (rover.on) rover.close(); if (walk.on) walk.exit(); if (inside.on) inside.close(); if (dive.picking) dive.cancel(); if (walk.picking) walk.cancel();
    if (section.picking || section.isOpen()) section.stop();
    picking = true; $('lifehint').classList.add('open'); $('chipLife').classList.add('on');
  }
  function cancel() { picking = false; $('lifehint').classList.remove('open'); if (!on) $('chipLife').classList.remove('on'); }
  function pickSite(pos) {
    const ray = camera.getPickRay(pos), p = ray && (globe.pick(ray, scene) || camera.pickEllipsoid(pos, E)); if (!p) return;
    const c = E.cartesianToCartographic(p); open(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude));
  }
  async function open(la, lo) {
    cancel(); $('chipLife').classList.add('on');
    if (!TABLES) buildTables();
    on = true; site = { la, lo };
    $('lifepanel').classList.remove('hide'); $('icepanel').classList.add('hide');
    if (!src) { src = new C.CustomDataSource('lander'); viewer.dataSources.add(src); }
    src.entities.removeAll();
    const carto = [C.Cartographic.fromDegrees(lo, la)];
    try { await C.sampleTerrain(terrain, 5, carto); } catch (_) {}
    const h = (carto[0].height || 0) * scene.verticalExaggeration;
    src.entities.add({ position: C.Cartesian3.fromDegrees(lo, la, h + 60, E),
      point: { pixelSize: 14, color: C.Color.fromCssColorString('#ffd36b'), outlineColor: C.Color.BLACK, outlineWidth: 3, disableDepthTestDistance: Infinity },
      label: { text: 'Orbilander', font: '600 13px Inter, sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -18), disableDepthTestDistance: Infinity } });
    $('lifeSite').textContent = `Landed at ${Math.abs(la).toFixed(2)}°${la >= 0 ? 'N' : 'S'}, ${Math.abs(lo).toFixed(2)}°${lo >= 0 ? 'E' : 'W'}. The model has no notion of place, so the site does not change the readings.`;
    camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(lo, la, h, E), 1), { offset: new C.HeadingPitchRange(0, -50 * Math.PI / 180, 60e3), duration: 2 });
    newRun();
  }
  function close() {
    if (!on) return;
    stop(); on = false; st = null; if (src) src.entities.removeAll();
    $('lifepanel').classList.add('hide'); $('chipLife').classList.remove('on'); if (ice.on) $('icepanel').classList.remove('hide');
  }

  // ---- wire up ----
  $('lifeInst').innerHTML = INST.map((x, i) => `<button id="lifeI${i}" title="${esc(x.what)}. Uses ${x.cost} unit${x.cost === 1 ? '' : 's'} of sample."><b>${esc(x.name)}</b><small>${esc(x.what)} · ${x.cost} unit${x.cost === 1 ? '' : 's'}</small></button>`).join('');
  INST.forEach((x, i) => { $('lifeI' + i).onclick = () => { stop(); act(i); }; });
  $('lifeCollect').onclick = () => { stop(); act('collect'); };
  $('lifeYes').onclick = () => { stop(); act('life'); };
  $('lifeNo').onclick = () => { stop(); act('none'); };
  $('lifeNew').onclick = newRun;
  $('lifeAutoC').onclick = () => run('conops');
  $('lifeAutoL').onclick = () => run('lookahead');
  $('lifeAutoStop').onclick = stop;
  $('lifeCompare').onclick = compare;
  $('lifeTruth').onchange = e => { truthMode = e.target.value; newRun(); };
  $('chipLife').onclick = () => (on ? close() : picking ? cancel() : begin());
  $('lifeCancel').onclick = cancel;
  $('lifeStripes').onclick = () => open(-81.2, -28);
  $('lifeClose').onclick = close;
  $('lifeMove').onclick = () => { close(); begin(); };
  window.addEventListener('keydown', e => { if (e.key === 'Escape') { if (picking) cancel(); else if (on) close(); } });
  return { get on() { return on; }, get picking() { return picking; }, pickSite, open, close, _model: { TABLES: () => TABLES, conops, lookahead, apply, fresh, infoGain, buildTables } };
})();
