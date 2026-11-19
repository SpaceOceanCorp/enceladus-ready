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

  // ---- real data: what Cassini actually measured, mapped onto the model's own scales ----
  // Cassini's INMS (gas) and CDA (ice grains) sampled the plume and the E ring it feeds, so these describe the ocean,
  // not one place on the surface. Three of the model's readings have a Cassini counterpart; the rest were never measured.
  // Each measurement is a range, so it is entered as "the reading lies in bins lo..hi", not a single made-up value.
  const ehH2 = (pH, aH2) => -0.0917 - 0.0592 * pH - 0.0296 * Math.log10(aH2);   // 2H+ + 2e- = H2(aq), 25 °C, E° = -0.0917 V
  const EH_HI = ehH2(8.5, 1e-7), EH_LO = ehH2(12, 1e-4);
  const binOf = (x, bins, lo, hi) => Math.max(0, Math.min(bins - 1, Math.floor((x - lo) / (hi - lo) * bins)));
  const S = {
    postberg09: { cite: 'Postberg et al. 2009, Nature 459:1098', url: 'https://doi.org/10.1038/nature08046' },
    postberg11: { cite: 'Postberg et al. 2011, Nature 474:620', url: 'https://doi.org/10.1038/nature10175' },
    waite09: { cite: 'Waite et al. 2009, Nature 460:487', url: 'https://doi.org/10.1038/nature08153' },
    postberg23: { cite: 'Postberg et al. 2023, Nature 618:489', url: 'https://doi.org/10.1038/s41586-023-05987-9' },
    waite17: { cite: 'Waite et al. 2017, Science 356:155', url: 'https://doi.org/10.1126/science.aai8703' },
    glein15: { cite: 'Glein, Baross & Waite 2015, Geochim. Cosmochim. Acta', url: 'https://arxiv.org/abs/1502.01946' },
    postberg18: { cite: 'Postberg et al. 2018, Nature 558:564', url: 'https://doi.org/10.1038/s41586-018-0246-4' },
  };
  const REAL = [
    { v: 'o7', name: 'Salinity', inst: 'Cassini CDA (ice grains)',
      value: 'about 0.5–2% salt by mass (sodium chloride, sodium carbonates)',
      map: '0 = fresh water, 1 = Earth seawater (3.5%), so 0.14–0.57', range: [0.5 / 3.5, 2 / 3.5], bins: 5, lo: 0, hi: 1,
      src: ['postberg09', 'postberg11'] },
    { v: 'o8', name: 'CHNOPS elements', inst: 'Cassini INMS (gas) and CDA (ice grains)',
      value: 'carbon, hydrogen, nitrogen and oxygen in the plume gas and organics; phosphorus as phosphates (2023); sulfur only weakly (H₂S)',
      map: 'share of the six elements detected: 5 or 6 of 6, so 0.83–1.0', range: [5 / 6, 1], bins: 5, lo: 0, hi: 1,
      src: ['waite09', 'postberg23'] },
    { v: 'o10', name: 'Redox potential', inst: 'Cassini INMS (H₂ in the plume) and CDA (salts, for pH)',
      value: `ocean H₂ about 10⁻⁷–10⁻⁴ mol/kg, pH 8.5–12, giving ${EH_LO.toFixed(2)} to ${EH_HI.toFixed(2)} V`,
      map: 'hydrogen half-reaction at 25 °C; the model’s scale runs −0.5 to 0 V, so anything below −0.5 V sits in its lowest bin', range: [EH_LO, EH_HI], bins: 10, lo: -0.5, hi: 0,
      src: ['waite17', 'postberg09', 'glein15'] },
  ];
  REAL.forEach(m => { m.b0 = binOf(m.range[0], m.bins, m.lo, m.hi); m.b1 = binOf(m.range[1] - 1e-9, m.bins, m.lo, m.hi); });
  const MISSING = [
    ['Amino acid diversity and chirality', 'Cassini’s mass spectrometers could not identify amino acids or tell left- from right-handed molecules.'],
    ['Cell-like membranes and autofluorescence', 'No microscope has looked at Enceladus material.'],
    ['Charged chain molecules (polyelectrolytes)', 'Needs a nanopore sequencer; never flown.'],
    ['Molecular complexity (assembly index)', 'Large organic molecules were found (Postberg et al. 2018), but their assembly index was not measured.'],
  ];
  // P(the applied measurements | life state), summing over the hidden parents (cell membrane, assembly index, amino acids),
  // so readings that share a parent are combined correctly rather than multiplied as if independent.
  function realLik(set) {
    const L = [0, 0], sum = (arr, a, b) => { let t = 0; for (let k = a; k <= b; k++) t += arr[k]; return t; };
    const m7 = set.find(m => m.v === 'o7'), m8 = set.find(m => m.v === 'o8'), m10 = set.find(m => m.v === 'o10');
    for (let s = 0; s < 2; s++) for (let o2 = 0; o2 < 2; o2++) for (let o4 = 0; o4 < 5; o4++) for (let o5 = 0; o5 < 23; o5++) {
      let p = CPD.o2[s][o2] * CPD.o4[s][o4] * CPD.o5[s][o5];
      if (m7) p *= sum(CPD.o7[o2], m7.b0, m7.b1);
      if (m8) p *= sum(O8[o4][o5], m8.b0, m8.b1);
      if (m10) p *= sum(O10[o5], m10.b0, m10.b1);
      L[s] += p;
    }
    return L;
  }
  const beliefFrom = set => { if (!set.length) return PRIOR; const L = realLik(set); return PRIOR * L[1] / (PRIOR * L[1] + (1 - PRIOR) * L[0]); };

  // ---- page state ----
  let on = false, picking = false, st = null, truth = 0, truthMode = 'random', auto = null, src = null, site = null, log = [];
  // what gets exported: one record per run (a run is one sample from "New sample" to the call), every step in it
  let by = 'manual', run = null, runs = [], lastCmp = null;
  let dataMode = 'cassini', applied = [];
  let pins = [], pinning = false, pinSrc = null, pinSeq = 0;
  const NUM = {   // the reading as a number, for the export (same values the log shows)
    o1: k => !!k, o2: k => !!k, o3: k => !!k,
    o5: k => Math.round((k + 0.5) * 22 / 23), o6: k => +((k + 0.5) / 10).toFixed(2),
    o7: k => +((k + 0.5) / 5).toFixed(1), o8: k => +((k + 0.5) / 5).toFixed(1), o10: k => +(-0.5 + (k + 0.5) * 0.05).toFixed(3),
  };
  const KEY = { o1: 'polyelectrolytes_found', o2: 'cell_membranes_seen', o3: 'autofluorescence', o5: 'amino_acid_diversity_of_22',
    o6: 'chirality_left_share', o7: 'salinity_0_1', o8: 'chnops_0_1', o10: 'redox_potential_V' };
  const r4 = v => +v.toFixed(4);
  const pr4 = v => +v.toPrecision(4);   // probabilities: keep 4 significant figures so 3e-7 doesn't become 0
  const llTxt = (la, lo) => `${Math.abs(la).toFixed(4)}°${la >= 0 ? 'N' : 'S'}, ${Math.abs(lo).toFixed(4)}°${lo >= 0 ? 'E' : 'W'}`;
  const llPlain = (la, lo) => `${la.toFixed(4)}, ${lo.toFixed(4)}`;
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
    const before = st.b, vol0 = st.vol, res = apply(st, a, truth);
    const rec = { step: st.steps, by, action: typeof a === 'number' ? 'instrument' : a === 'collect' ? 'collect' : 'declare',
      chance_of_life_before: pr4(before), tank_before: vol0 };
    if (a === 'collect') { rec.fallout_units = res.f; }
    else if (res && res.r) {
      const ins = INST[a];
      rec.instrument = ins.name; rec.sample_units = ins.cost;
      rec.readings = Object.fromEntries(ins.vars.map((v, i) => [KEY[v], NUM[v](res.r.vals[i])]));
      rec.likelihood_ratio_life = +(res.r.L1 / res.r.L0).toPrecision(4);
    } else rec.declared = a === 'life' ? 'life' : 'no life';
    rec.chance_of_life_after = pr4(st.b); rec.tank_after = st.vol;
    if (run) run.steps.push(rec);
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
    if (run) run.result = { declared: said ? 'life' : 'no life', simulated_truth: truth ? 'life' : 'no life', correct: right,
      steps: st.steps - 1, sample_units_used: st.used, final_chance_of_life: pr4(st.b), finished: new Date().toISOString() };
    log.push(`<b>Declared: ${said ? 'life' : 'no life'}.</b> The sample ${truth ? 'did contain life' : 'had no life'}, so the call was <b class="${right ? 'up' : 'down'}">${right ? 'right' : 'wrong'}</b>. ${st.steps - 1} step${st.steps === 2 ? '' : 's'}, ${st.used} unit${st.used === 1 ? '' : 's'} of sample used.`);
  }
  function suggestion() {
    if (!st || st.done) return '';
    const a = lookahead({ ...st });
    if (a === 'life' || a === 'none') return `Confidence has passed the repo's ${a === 'life' ? '99.9%' : '0.1%'} threshold: declare ${a === 'life' ? 'life' : 'no life'}.`;
    if (a === 'collect') return 'Not enough sample for any instrument: collect fallout.';
    return `Run ${INST[a].name}: expected to tell you the most right now (${infoGain(a, st.b).toFixed(2)} bits).`;
  }
  const srcLinks = m => m.src.map(k => `<a href="${S[k].url}" target="_blank" rel="noopener">${esc(S[k].cite)}</a>`).join('; ');
  function renderReal() {
    const b = beliefFrom(applied);
    $('lifeBel').style.width = (100 * b) + '%'; $('lifeBelV').textContent = pct(b);
    $('lifeRealList').innerHTML = REAL.map((m, i) => {
      const done = applied.includes(m), L = realLik([m]);
      return `<li><div class="hd"><b>${esc(m.name)}</b><button data-i="${i}" ${done ? 'disabled' : ''}>${done ? 'Applied' : 'Apply'}</button></div>`
        + `<div>${esc(m.value)}</div><div class="cite">${esc(m.inst)}. On the model's scale: ${esc(m.map)}. On its own: ${evidence({ L1: L[1], L0: L[0] })}.</div>`
        + `<div class="cite">Source: ${srcLinks(m)}</div></li>`;
    }).join('');
    $('lifeRealMissing').innerHTML = MISSING.map(([n, why]) => `<li><b>${esc(n)}</b><div class="cite">${esc(why)}</div></li>`).join('');
    $('lifeRealAll').disabled = applied.length === REAL.length; $('lifeRealReset').disabled = !applied.length;
    $('lifeLog').innerHTML = log.slice(-30).reverse().map(t => `<li>${t}</li>`).join('');
    $('lifeStatus').textContent = !applied.length ? 'No Cassini data applied yet: this is the model’s starting chance.'
      : `${applied.length} of ${REAL.length} Cassini measurements applied. The mission would declare only above 99.9% or below 0.1%, so this is ${b >= HI ? 'enough to declare life' : b <= LO ? 'enough to declare no life' : 'undecided'}.`;
  }
  function applyReal(m) {
    if (!m || applied.includes(m)) return;
    const before = beliefFrom(applied); applied.push(m); const after = beliefFrom(applied), L = realLik([m]);
    if (run) {
      run.steps.push({ step: run.steps.length + 1, by, action: 'cassini_measurement', measurement: m.name, instrument: m.inst,
        measured_value: m.value, model_variable: KEY[m.v], model_value_range: [+m.range[0].toFixed(3), +m.range[1].toFixed(3)], model_bins: [m.b0, m.b1],
        mapping: m.map, sources: m.src.map(k => S[k]), likelihood_ratio_life: +(L[1] / L[0]).toPrecision(4),
        chance_of_life_before: pr4(before), chance_of_life_after: pr4(after) });
      run.result = { applied: applied.map(x => x.name), final_chance_of_life: pr4(after),
        decision: after >= HI ? 'life' : after <= LO ? 'no life' : 'undecided', thresholds: [LO, HI], updated: new Date().toISOString() };
    }
    log.push(`<b>Cassini: ${esc(m.name)}</b>: ${esc(m.value)}. On its own: ${evidence({ L1: L[1], L0: L[0] })}. Chance of life ${pct(before)} → ${pct(after)}.`);
    renderReal();
  }
  function showMode() {
    const real = dataMode === 'cassini';
    $('lifeReal').classList.toggle('hide2', !real);
    ['lifeSimTank', 'lifeSimCtl', 'lifeSimCmp'].forEach(id => $(id).classList.toggle('hide2', real));
    $('lifeData').value = dataMode;
  }
  function setData(mode) { if (mode === dataMode) return; stop(); dataMode = mode; showMode(); if (on) newRun(); }
  function render() {
    if (dataMode === 'cassini') return renderReal();
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
    if (dataMode === 'cassini') {
      st = null; applied = [];
      log = [`Starting chance of life: ${pct(PRIOR)} (the model's prior). Apply Cassini's measurements to update it.`];
      run = { run: runs.length + 1, data_mode: 'cassini', site: site ? { lat: r4(site.la), lon: r4(site.lo) } : null, started: new Date().toISOString(),
        prior_chance_of_life: PRIOR, note: 'Plume and E-ring measurements describe the ocean as a whole; the landing site does not change them.',
        steps: [], result: null };
      runs.push(run); showMode(); renderReal(); return;
    }
    truth =truthMode === 'life' ? 1 : truthMode === 'none' ? 0 : Math.random() < PRIOR ? 1 : 0;
    st = fresh(); log = [`New sample. Starting chance of life: ${pct(PRIOR)} (the repo's prior). Tank empty.`];
    run = { run: runs.length + 1, data_mode: 'simulated', site: site ? { lat: r4(site.la), lon: r4(site.lo) } : null, started: new Date().toISOString(),
      truth_setting: truthMode, prior_chance_of_life: PRIOR, steps: [], result: null };
    runs.push(run);
    showMode(); render();
  }
  function autoRun(kind) {
    stop(); by = kind;
    const pol = kind === 'conops' ? conops : lookahead;
    if (kind === 'conops') { st.modeAcc = true; st.prev = 0; }
    log.push(`<i>Running ${kind === 'conops' ? 'the ConOps baseline' : 'the one-step lookahead'} automatically…</i>`);
    auto = setInterval(() => { if (!st || st.done || st.steps >= STEP_CAP) { if (st && !st.done) { act(st.b >= 0.5 ? 'life' : 'none'); } stop(); return; } act(pol(st)); }, 450);
    render();
  }
  function stop() { by = 'manual'; if (auto) { clearInterval(auto); auto = null; if (st) render(); } }
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
    const sum = r => ({ wrong_call_rate: +(r[0] / n).toFixed(4), mean_steps: +(r[1] / n).toFixed(2), mean_sample_units: +(r[2] / n).toFixed(1), missed_life: r[3] });
    lastCmp = { landings_each: n, site: site ? { lat: r4(site.la), lon: r4(site.lo) } : null, ran: new Date().toISOString(),
      conops_baseline: sum(res.conops), one_step_lookahead: sum(res.lookahead) };
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
  async function open(la, lo, mode) {
    if (mode) { stop(); dataMode = mode; }
    cancel(); $('chipLife').classList.add('on');
    if (rover.on) rover.close();
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
    $('lifeSite').textContent = `Landed at ${llTxt(la, lo)}. The model has no notion of place, so the site does not change the readings.`;
    camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(lo, la, h, E), 1), { offset: new C.HeadingPitchRange(0, -50 * Math.PI / 180, 60e3), duration: 2 });
    newRun();
  }
  function close() {
    if (!on) return;
    stop(); setPinning(false); on = false; st = null; if (src) src.entities.removeAll();
    $('lifepanel').classList.add('hide'); $('chipLife').classList.remove('on'); if (ice.on) $('icepanel').classList.remove('hide');
  }

  // ---- pins, copying coordinates, export ----
  let toastT = null;
  function toast(t) { $('lifeToast').textContent = t; clearTimeout(toastT); toastT = setTimeout(() => { $('lifeToast').textContent = ''; }, 3500); }
  function flash(btn, msg) {   // feedback on the button itself, since the toast line sits far down the panel
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = msg; clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = btn.dataset.label; delete btn.dataset.label; }, 1600);
  }
  // Copy synchronously first, while the click still counts as a user gesture; the async Clipboard API is only a
  // fallback, because some browsers refuse it ("write permission denied") and by the time it fails the gesture is gone.
  function copy(text, what, btn) {
    const done = ok => {
      flash(btn, ok ? 'Copied ✓' : 'Copy failed');
      toast(ok ? `Copied ${what}: ${text.length > 60 ? text.slice(0, 57) + '…' : text}` : `Could not reach the clipboard. ${what}: ${text}`);
      if (!ok) window.prompt(`Copy ${what} (Ctrl+C, then Enter):`, text);
    };
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(t); t.focus(); t.select(); t.setSelectionRange(0, text.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    t.remove(); if (btn) btn.focus({ preventScroll: true });
    if (ok) return done(true);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    else done(false);
  }
  function savePins() { try { localStorage.setItem('enc.life.pins', JSON.stringify(pins)); } catch (_) {} }
  function loadPins() {
    try { const p = JSON.parse(localStorage.getItem('enc.life.pins') || '[]'); if (Array.isArray(p)) pins = p.filter(x => isFinite(x.lat) && isFinite(x.lon)); } catch (_) {}
    pinSeq = pins.reduce((m, x) => Math.max(m, x.n || 0), 0);
  }
  async function drawPins() {
    if (!pinSrc) { pinSrc = new C.CustomDataSource('lifePins'); viewer.dataSources.add(pinSrc); }
    pinSrc.entities.removeAll();
    const carto = pins.map(p => C.Cartographic.fromDegrees(p.lon, p.lat));
    if (carto.length) { try { await C.sampleTerrain(terrain, 5, carto); } catch (_) {} }
    pins.forEach((p, i) => {
      const h = (carto[i].height || 0) * scene.verticalExaggeration;
      pinSrc.entities.add({ position: C.Cartesian3.fromDegrees(p.lon, p.lat, h + 40, E),
        point: { pixelSize: 10, color: C.Color.fromCssColorString('#ff6b9a'), outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Infinity },
        label: { text: `Pin ${p.n}`, font: '600 12px Inter, sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -14), disableDepthTestDistance: Infinity } });
    });
  }
  function renderPins() {
    $('lifePins').innerHTML = pins.length ? pins.map((p, i) => `<li><span><b>Pin ${p.n}</b> · ${llTxt(p.lat, p.lon)}</span>`
      + `<button data-a="copy" data-i="${i}" title="Copy as: latitude, longitude">Copy</button><button data-a="land" data-i="${i}">Land here</button><button data-a="del" data-i="${i}" aria-label="Remove pin ${p.n}">✕</button></li>`).join('')
      : '<li class="cite">No pins yet.</li>';
    $('lifeCopyPins').disabled = $('lifeClearPins').disabled = !pins.length;
  }
  function addPin(la, lo) {
    pins.push({ n: ++pinSeq, lat: r4(la), lon: r4(lo), added: new Date().toISOString() });
    savePins(); renderPins(); drawPins(); toast(`Pin ${pinSeq} at ${llTxt(la, lo)}`);
  }
  function addPinAt(pos) {
    const ray = camera.getPickRay(pos), p = ray && (globe.pick(ray, scene) || camera.pickEllipsoid(pos, E)); if (!p) return;
    const c = E.cartesianToCartographic(p); addPin(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude));
  }
  function setPinning(v) { pinning = v; $('lifePinMode').setAttribute('aria-pressed', String(v)); $('lifePinMode').textContent = v ? 'Done dropping pins' : 'Drop pins by clicking'; }
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const csvCell = v => { if (v === undefined || v === null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function exportCsv() {
    if (!run) return;
    const rk = Object.values(KEY);
    const cols = ['run', 'data_mode', 'site_lat', 'site_lon', 'truth_setting', 'step', 'by', 'action', 'measurement', 'instrument', 'measured_value', 'model_value_range', 'mapping', 'source', 'sample_units', 'fallout_units', ...rk,
      'likelihood_ratio_life', 'chance_of_life_before', 'chance_of_life_after', 'tank_before', 'tank_after', 'declared', 'simulated_truth', 'correct'];
    const rows = run.steps.map(s => {
      const o = { run: run.run, data_mode: run.data_mode, site_lat: run.site && run.site.lat, site_lon: run.site && run.site.lon, truth_setting: run.truth_setting, ...s, ...(s.readings || {}) };
      if (s.model_value_range) o.model_value_range = s.model_value_range.join(' to ');
      if (s.sources) o.source = s.sources.map(x => `${x.cite} ${x.url}`).join('; ');
      if (s.action === 'declare' && run.result) { o.simulated_truth = run.result.simulated_truth; o.correct = run.result.correct; }
      return cols.map(c => csvCell(o[c])).join(',');
    });
    download(`enceladus-life-run${run.run}-${stamp()}.csv`, '﻿' + [cols.join(','), ...rows].join('\n') + '\n', 'text/csv');
    toast(`Saved run ${run.run}: ${run.steps.length} step${run.steps.length === 1 ? '' : 's'}${run.result ? '' : ' (no result yet)'}.`);
  }
  function exportJson() {
    const doc = {
      exported: new Date().toISOString(), page: location.href.split('#')[0],
      coordinates: 'latitude, longitude in degrees; longitude east-positive, -180 to 180; sphere of radius 252.1 km',
      model: { source: 'https://github.com/sisl/LifeDetection', paper: 'https://arxiv.org/abs/2510.08812', prior_chance_of_life: PRIOR,
        declare_thresholds: [LO, HI], tank_units: TANK, fallout_mean_units: FALL_MEAN,
        instruments: INST.map(x => ({ name: x.name, measures: x.what, sample_units: x.cost })),
        note: 'In simulated runs, readings are drawn from the model. In Cassini runs, real plume and E-ring measurements (with sources) are entered as bin ranges on the model’s scales. Neither depends on the landing site.' },
      cassini_measurements: REAL.map(m => ({ name: m.name, instrument: m.inst, measured_value: m.value, mapping: m.map, model_variable: KEY[m.v], model_bins: [m.b0, m.b1], sources: m.src.map(k => S[k]) })),
      not_measured_by_cassini: MISSING.map(([n, why]) => ({ name: n, why })),
      runs, pins, strategy_comparison: lastCmp,
    };
    download(`enceladus-life-detection-${stamp()}.json`, JSON.stringify(doc, null, 2), 'application/json');
    toast(`Saved ${runs.length} run${runs.length === 1 ? '' : 's'} and ${pins.length} pin${pins.length === 1 ? '' : 's'}.`);
  }
  loadPins();

  // ---- wire up ----
  $('lifeInst').innerHTML = INST.map((x, i) => `<button id="lifeI${i}" title="${esc(x.what)}. Uses ${x.cost} unit${x.cost === 1 ? '' : 's'} of sample."><b>${esc(x.name)}</b><small>${esc(x.what)} · ${x.cost} unit${x.cost === 1 ? '' : 's'}</small></button>`).join('');
  INST.forEach((x, i) => { $('lifeI' + i).onclick = () => { stop(); act(i); }; });
  $('lifeCollect').onclick = () => { stop(); act('collect'); };
  $('lifeYes').onclick = () => { stop(); act('life'); };
  $('lifeNo').onclick = () => { stop(); act('none'); };
  $('lifeNew').onclick = newRun;
  $('lifeAutoC').onclick = () => autoRun('conops');
  $('lifeAutoL').onclick = () => autoRun('lookahead');
  $('lifeCopySite').onclick = () => site && copy(llPlain(site.la, site.lo), 'site lat, lon', $('lifeCopySite'));
  $('lifePinSite').onclick = () => site && addPin(site.la, site.lo);
  $('lifePinMode').onclick = () => setPinning(!pinning);
  $('lifeCopyPins').onclick = () => copy(pins.map(p => `Pin ${p.n}\t${llPlain(p.lat, p.lon)}`).join('\n'), `${pins.length} pin${pins.length === 1 ? '' : 's'}`, $('lifeCopyPins'));
  $('lifeClearPins').onclick = () => { if (confirm(`Remove all ${pins.length} pins?`)) { pins = []; pinSeq = 0; savePins(); renderPins(); drawPins(); } };
  $('lifePins').onclick = e => {
    const b = e.target.closest('button'); if (!b) return; const p = pins[+b.dataset.i]; if (!p) return;
    if (b.dataset.a === 'copy') copy(llPlain(p.lat, p.lon), `pin ${p.n} lat, lon`, b);
    else if (b.dataset.a === 'land') { setPinning(false); open(p.lat, p.lon); }
    else if (b.dataset.a === 'del') { pins.splice(+b.dataset.i, 1); savePins(); renderPins(); drawPins(); }
  };
  $('lifeExportCsv').onclick = exportCsv;
  $('lifeExportJson').onclick = exportJson;
  $('lifeData').onchange = e => setData(e.target.value);
  $('lifeRealList').onclick = e => { const b = e.target.closest('button'); if (b) { by = 'manual'; applyReal(REAL[+b.dataset.i]); } };
  $('lifeRealAll').onclick = () => { by = 'apply_all'; REAL.forEach(m => applyReal(m)); by = 'manual'; };
  $('lifeRealReset').onclick = newRun;
  renderPins(); if (pins.length) drawPins();
  $('lifeAutoStop').onclick = stop;
  $('lifeCompare').onclick = compare;
  $('lifeTruth').onchange = e => { truthMode = e.target.value; newRun(); };
  $('chipLife').onclick = () => (on ? close() : picking ? cancel() : begin());
  $('lifeCancel').onclick = cancel;
  $('lifeStripes').onclick = () => open(-81.2, -28);
  $('lifeClose').onclick = close;
  $('lifeMove').onclick = () => { close(); begin(); };
  window.addEventListener('keydown', e => { if (e.key === 'Escape') { if (picking) cancel(); else if (on) close(); } });
  return { get on() { return on; }, get picking() { return picking; }, get pinning() { return on && pinning; }, addPinAt, setData, pickSite, open, close, _model: { TABLES: () => TABLES, conops, lookahead, apply, fresh, infoGain, buildTables } };
})();
