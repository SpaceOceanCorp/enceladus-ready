// ---------- guided tour: one mission story through every tool on the globe ----------
// Seven steps, each opening an existing mode with sensible settings. Nothing here adds data: every number the
// narration gives is shown, with its source, in the panel or mode it opens.
const tour = (() => {
  let on = false, i = 0, diveWatch = null;
  const photo = id => (photos || []).find(p => p.id === id);
  const feat = name => feats.find(f => f.name === name);
  // On wider screens the tour card sits at the bottom, so after each move the globe is nudged up out from behind it.
  const lift = () => { if (on && innerWidth > 640 && innerHeight > 520) shiftScreen(0, -Math.min(170, $('tourpanel').offsetHeight * 0.6)); };
  const fly = (lon, lat, alt, pitchDeg = -90, heading = 0, dur = 2.4) => camera.flyTo({
    destination: C.Cartesian3.fromDegrees(lon, lat, alt, E), orientation: { heading: heading * Math.PI / 180, pitch: pitchDeg * Math.PI / 180, roll: 0 }, duration: dur, complete: lift });
  const flyAround = (lon, lat, range, pitchDeg, dur = 2.6) => camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(lon, lat, 0, E), 1),
    { offset: new C.HeadingPitchRange(0, pitchDeg * Math.PI / 180, range), duration: dur, complete: lift });
  // close whatever mode is open, so each step starts clean
  function clearModes() {
    if (diveWatch) { clearInterval(diveWatch); diveWatch = null; }
    if (rover.on) rover.close(); if (life.on) life.close(); if (inside.on) inside.close();
    if (section.picking || section.isOpen()) section.stop(); if (walk.on) walk.exit(); if (walk.picking) walk.cancel();
    if (dive.picking) dive.cancel(); if (ice.on) setIce(false);
    if (document.getElementById('info').classList.contains('open')) closeInfo();
  }
  const btn = (label, fn, go) => ({ label, fn, go });
  const STEPS = [
    { title: 'Arrive: a moon that sprays its ocean into space',
      text: 'Enceladus is a 504 km ball of ice orbiting Saturn every 33 hours. In 2005 Cassini found jets of water vapour and ice grains rising from its south pole, and later flybys showed they come from a salty ocean under the ice. The photo is a real Cassini frame, taken looking back toward the Sun so the plumes glow. The camera markers around the south pole open more of them.',
      enter() { flyAround(-30, -62, 1.7e6, -62); const p = photo('n1669801856') || (photos || [])[0]; if (p) { markSelected(p); showInfo(p); } },
      buttons: [btn('Another plume photo', () => { const p = photo('n1711553974'); if (p) { markSelected(p); showInfo(p); } })] },
    { title: 'Pick a site: the tiger stripes',
      text: 'The jets rise from four parallel fractures nicknamed the tiger stripes, each about 130 km long. The orange dots are the 100 jet sources Cassini traced along them (Porco et al. 2014). The stripes are warmer than the rest of the surface: up to about 190 K against about 75 K elsewhere. This is where a lander would go.',
      enter() { flyAround(-30, -86, 420e3, -58); const f = feat('Baghdad Sulcus'); if (f) { markSelected(f); showInfo(f); } },
      buttons: [btn('Show Damascus Sulcus', () => { const f = feat('Damascus Sulcus'); if (f) flyTo(f, false); })] },
    { title: 'Look inside: how deep is the ocean?',
      text: 'Nobody has measured the ice directly. Gravity, shape and wobble measurements say it is thinnest here at the south pole. Models disagree on how thin: Čadek et al. 2016 put it at about 4 km under the stripes, while PlanetProfile’s one-dimensional model gives 21 km everywhere. The cut is true scale. Use the depth buttons in the panel to reach the ocean and the rocky core.',
      enter() { inside.open(); setIceModel('cadek2016'); inside.setSpot(-87.5, -30); setTimeout(() => inside.on && inside.setDepth(+document.querySelector('#insideStops [data-stop="ice"]').dataset.km || 4, true), 2600); },
      buttons: [btn('Čadek et al. 2016', () => setIceModel('cadek2016')), btn('PlanetProfile', () => setIceModel('planetprofile'))] },
    { title: 'Land and sample: is there life?',
      text: 'NASA’s proposed Enceladus Orbilander would orbit, then land near the stripes and test plume fallout with six instruments. Collect fallout and run the instruments yourself, or let the mission’s planned sequence run. The chance of life updates after each reading; every number comes from the published model by Stanford and NASA Ames.',
      enter() { life.open(-81.2, -28); },
      buttons: [btn('Run the baseline for me', () => document.getElementById('lifeAutoC').click())] },
    { title: 'Explore: driving when messages take over an hour',
      text: 'No rover is planned for Enceladus, but this shows what driving here would mean. Slopes come from Cassini’s height map, the stripes are no-go zones, and a plan from Earth takes over an hour to arrive and only gets through while Earth is above the horizon and not behind Saturn.',
      enter() { rover.open(-81.2, -28); },
      buttons: [btn('Plan and send a drive', () => { document.getElementById('roverSuggest').click(); document.getElementById('roverSend').click(); document.querySelector('#roverSpeed [data-s="24"]').click(); })] },
    { title: 'Dive: into the ocean under the stripes',
      text: 'Under the ice lies the ocean, about as salty as a third of Earth’s seawater in PlanetProfile’s model, kept liquid by tidal heating. Swim or take a submarine between the ice ceiling and the seafloor. The ice shape comes from the selected interior model; small-scale textures and the seafloor vents are illustrative. Leave the dive to come back here.',
      enter() { flyAround(-60, -84, 250e3, -60); },
      buttons: [btn('Start the dive', () => {
        if (typeof INT === 'undefined' || !INT) return;
        $('tourpanel').classList.add('hide');
        dive.go(-84, -60);
        diveWatch = setInterval(() => { if (!dive.running && !dive.picking) { clearInterval(diveWatch); diveWatch = null; if (on) { $('tourpanel').classList.remove('hide'); go(6); } } }, 800);
      }, true)] },
    { title: 'Debrief: what is real and what is modelled',
      text: '<b>Measured:</b> the imagery and heights (Cassini, Schenk & McKinnon 2024), the feature names, the 100 jet sources, the Cassini photos, and where Earth and the Sun are in the sky (JPL Horizons). <b>Modelled:</b> the ice shell, ocean and core (published models, no direct measurement yet), the Orbilander’s life-detection science (sisl/LifeDetection), and the rover, which is imaginary. Each panel lists its sources.',
      html: true,
      enter() { fly(0, -20, 1.15e6, -90, 0, 2.2); },
      buttons: [btn('Start over', () => go(0)), btn('Explore on my own', () => stop(), true)] },
  ];
  function render() {
    const s = STEPS[i];
    $('tourStep').textContent = `Step ${i + 1} of ${STEPS.length}`;
    $('tourTitle').textContent = s.title;
    if (s.html) $('tourText').innerHTML = s.text; else $('tourText').textContent = s.text;
    $('tourActions').innerHTML = '';
    s.buttons.forEach(b => { const el = document.createElement('button'); el.textContent = b.label; if (b.go) el.className = 'go'; el.onclick = b.fn; $('tourActions').appendChild(el); });
    $('tourBack').disabled = i === 0; $('tourNext').textContent = i === STEPS.length - 1 ? 'Finish' : 'Next';
    $('tourDots').innerHTML = STEPS.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'done' : ''}"></i>`).join('');
  }
  function go(k) {
    i = Math.max(0, Math.min(STEPS.length - 1, k));
    clearModes(); render(); STEPS[i].enter();
  }
  function start() { on = true; $('tourpanel').classList.remove('hide'); $('chipTour').classList.add('on'); document.body.classList.add('touring'); go(0); }
  function stop() { on = false; clearModes(); $('tourpanel').classList.add('hide'); $('chipTour').classList.remove('on'); document.body.classList.remove('touring'); }
  $('chipTour').onclick = () => (on ? stop() : start());
  $('tourNext').onclick = () => (i === STEPS.length - 1 ? stop() : go(i + 1));
  $('tourBack').onclick = () => go(i - 1);
  $('tourClose').onclick = stop;
  window.addEventListener('keydown', e => { if (!on || dive.running || (e.target.closest && e.target.closest('input, textarea, select'))) return; if (e.key === 'ArrowRight' && e.altKey) go(i + 1); if (e.key === 'ArrowLeft' && e.altKey) go(i - 1); });
  return { get on() { return on; }, get step() { return i; }, start, stop, go };
})();
