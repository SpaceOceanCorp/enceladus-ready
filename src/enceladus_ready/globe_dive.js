// Dive mode: swim through Enceladus's ocean, under the ice shell and above the rocky core.
//
// Loaded on demand by the globe page (import('./dive.js')). Units are kilometres in a
// body-centred frame: x toward 0 E, y toward 90 E, z toward the north pole.
//
// What is data and what is not:
// * The ice ceiling's shape is the selected ice-thickness model (features larger than ~200 km).
// * The tiger-stripe fractures follow the 100 Porco et al. (2014) jet source positions.
// * Feature names overhead are the IAU names at their mapped positions.
// * Small-scale texture of the ice and seafloor, and the hydrothermal vents, are illustrative.
//   Cassini found evidence of hot water reacting with rock (silica grains, hydrogen), but no one
//   knows where vents are or what the seafloor looks like.
// * Under kilometres of ice the ocean is completely dark; the dive lights are for viewing.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const D2R = Math.PI / 180;
const toXYZ = (lat, lon, r) => new THREE.Vector3(r * Math.cos(lat * D2R) * Math.cos(lon * D2R), r * Math.cos(lat * D2R) * Math.sin(lon * D2R), r * Math.sin(lat * D2R));
const toLL = v => { const r = v.length(); return { lat: Math.asin(v.z / r) / D2R, lon: Math.atan2(v.y, v.x) / D2R, r }; };

// Surfaces lit only by the diver's lamps, with fog that swallows everything beyond a few km.
const SURF_VS = `
varying vec3 vPos; varying vec3 vNormal;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vPos = position; vNormal = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const SURF_FS = `
uniform vec3 uColor; uniform vec3 uColor2; uniform vec3 uCam; uniform vec3 uLight; uniform vec3 uLampDir; uniform float uLamp;
uniform float uFog; uniform vec3 uFogColor; uniform float uScale; uniform float uAmbient; uniform float uBump;
varying vec3 vPos; varying vec3 vNormal;
#include <common>
#include <logdepthbuf_pars_fragment>
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n3(p); p *= 2.07; a *= 0.5; } return s; }
void main() {
  #include <logdepthbuf_fragment>
  vec3 toLamp = uLight - vPos; float d = length(toLamp); vec3 L = toLamp / d;
  float dc = length(uCam - vPos);
  vec3 q = vPos * uScale;
  float n = fbm(q);
  float e = 0.04;
  vec3 g = vec3(fbm(q + vec3(e,0,0)) - n, fbm(q + vec3(0,e,0)) - n, fbm(q + vec3(0,0,e)) - n) / e;
  vec3 N = normalize(normalize(vNormal) - uBump * g);
  if (dot(N, L) < 0.0) N = -N;
  float cone = smoothstep(0.45, 0.93, dot(-L, uLampDir));
  float lamp = uLamp * max(dot(N, L), 0.0) * (0.18 + 0.82 * cone) / (1.0 + 0.06 * d * d);
  vec3 col = mix(uColor, uColor2, smoothstep(0.3, 0.75, n)) * (0.8 + 0.4 * fbm(q * 0.13));
  vec3 lit = col * (uAmbient + 2.4 * lamp);
  float fogf = 1.0 - exp(-uFog * dc * dc);
  gl_FragColor = vec4(mix(lit, uFogColor, fogf), 1.0);
}`;

function sphereShell(radiusAt, step) {
  const nLat = Math.round(180 / step) + 1, nLon = Math.round(360 / step) + 1;
  const pos = new Float32Array(nLat * nLon * 3);
  let k = 0;
  for (let i = 0; i < nLat; i++) {
    const lat = -90 + i * step;
    for (let j = 0; j < nLon; j++) {
      const lon = -180 + j * step, r = radiusAt(lat, lon), v = toXYZ(lat, lon, r);
      pos[k++] = v.x; pos[k++] = v.y; pos[k++] = v.z;
    }
  }
  const idx = new Uint32Array((nLat - 1) * (nLon - 1) * 6);
  k = 0;
  for (let i = 0; i < nLat - 1; i++) for (let j = 0; j < nLon - 1; j++) {
    const a = i * nLon + j, b = a + nLon;
    idx[k++] = a; idx[k++] = b; idx[k++] = a + 1; idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function surfMaterial(c1, c2, scale, bump, ambient) {
  return new THREE.ShaderMaterial({
    vertexShader: SURF_VS, fragmentShader: SURF_FS, side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(c1) }, uColor2: { value: new THREE.Color(c2) }, uCam: { value: new THREE.Vector3() }, uLight: { value: new THREE.Vector3() },
      uLampDir: { value: new THREE.Vector3(1, 0, 0) }, uLamp: { value: 1 }, uFog: { value: 0.0035 },
      uFogColor: { value: new THREE.Color(0x02101c) }, uScale: { value: scale }, uAmbient: { value: ambient }, uBump: { value: bump },
    },
  });
}

// Deterministic pseudo-random numbers so the illustrative vents are always in the same place.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function start(opts) {
  const { interiorAt, model, feats, jets, onExit, tempAt } = opts;
  const ceilingAt = (lat, lon) => { const c = interiorAt(lat, lon, model); return c.surf - c.ice; };
  const surfAt = (lat, lon) => interiorAt(lat, lon, model).surf;
  const floorNoise = (lat, lon) => { const v = toXYZ(lat, lon, 1); return 0.35 * Math.sin(v.x * 37 + v.y * 11) * Math.cos(v.y * 29 - v.z * 17) + 0.25 * Math.sin(v.z * 53 + v.x * 23); };
  const floorAt = (lat, lon) => model.core_km + floorNoise(lat, lon);

  // ---------- DOM ----------
  const root = document.createElement('div');
  root.id = 'dive';
  root.innerHTML = `
  <style>
    #dive{position:fixed;inset:0;z-index:50;background:#02101c;color:#e9edf3;font:14px/1.4 Inter,system-ui,sans-serif;overflow:hidden;touch-action:none}
    #dive canvas{display:block;width:100%;height:100%;cursor:grab}
    #dive canvas:active{cursor:grabbing}
    #dive .card{background:rgba(8,20,32,.82);border:1px solid rgba(255,255,255,.12);border-radius:12px;backdrop-filter:blur(8px)}
    #dive .hud{position:absolute;top:16px;left:16px;padding:14px 16px;width:300px;max-width:calc(100vw - 32px)}
    #dive .hud h2{margin:0 0 8px;font-size:16px;font-weight:600}
    #dive .hud dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-variant-numeric:tabular-nums;font-size:13px}
    #dive .hud dt{color:#9aa4b2}#dive .hud dd{margin:0}
    #dive .hud .over{margin-top:8px;font-size:12.5px;color:#cfe3f5}
    #dive .note{position:absolute;left:16px;bottom:16px;max-width:min(520px,calc(100vw - 32px));padding:10px 14px;font-size:12px;color:#9aa4b2}
    #dive .top{position:absolute;top:16px;right:16px;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    #dive button{font:500 13px Inter,sans-serif;color:#e9edf3;background:rgba(8,20,32,.82);border:1px solid rgba(255,255,255,.18);border-radius:18px;padding:8px 14px;cursor:pointer}
    #dive button:hover{background:#1c2b3a}
    #dive button.on{background:#8ab4f8;color:#0b1220;border-color:#8ab4f8}
    #dive button.exit{background:#8ab4f8;color:#0b1220;border-color:#8ab4f8;font-weight:600}
    #dive .ctl{position:absolute;right:16px;bottom:16px;padding:12px 14px;width:330px;max-width:calc(100vw - 32px);user-select:none;-webkit-user-select:none}
    #dive .ctl .row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0}
    #dive .ctl .t{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#9aa4b2;width:48px}
    #dive .ctl .row button{padding:6px 10px;font-size:12.5px}
    #dive .ctl .pads{display:flex;gap:14px;margin:8px 0}
    #dive .ctl .padg{flex:1}
    #dive .ctl .g3{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:4px}
    #dive .ctl .g3 button{height:42px;padding:0;border-radius:10px;font-size:15px}
    #dive .ctl .g3 button small{display:block;font-size:9.5px;color:#9aa4b2;line-height:1}
    #dive .ctl button.held{background:#8ab4f8;color:#0b1220}
    #dive .ctl button.held small{color:#0b1220}
    #dive .ctl .keys{font-size:11px;color:#9aa4b2;margin-top:6px;line-height:1.5}
    #dive .ctl .keys b{color:#e9edf3}
    #dive .tip{position:absolute;left:50%;top:70px;transform:translateX(-50%);padding:8px 14px;font-size:13px;color:#e9edf3;display:none}
    #dive .tip.open{display:block}
    #dive .lbl{position:absolute;transform:translate(-50%,-100%);font:600 12px Inter,sans-serif;color:#bfe6ff;text-shadow:0 0 6px #000,0 0 2px #000;white-space:nowrap;pointer-events:none}
    #dive .lbl.vent{color:#ffc58a}
    #dive .lbl small{display:block;font-weight:400;color:#8fb3cc;text-align:center}
    #dive .brand{position:absolute;left:50%;top:16px;transform:translateX(-50%);opacity:.92;pointer-events:none;background:rgba(8,20,32,.78);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:7px 14px}
    #dive .brand img{display:block;height:20px;width:auto}
    @media (max-width:1100px){ #dive .brand{top:auto;bottom:16px;left:auto;right:16px;transform:none} #dive .brand img{height:16px} }
    #dive .map{position:absolute;right:16px;top:64px;padding:10px 12px 8px;user-select:none;-webkit-user-select:none}
    #dive .map .head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
    #dive .map .head b{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#cfe3f5}
    #dive .map .head button{padding:3px 9px;font-size:11.5px;border-radius:12px}
    #dive .map .body{display:flex;gap:10px;align-items:stretch}
    #dive .map canvas{width:190px;height:190px;cursor:crosshair;border-radius:50%}
    #dive .map .gauge{position:relative;width:64px;height:190px}
    #dive .map .gauge canvas{width:64px;height:190px;border-radius:6px;cursor:default}
    #dive .map .cap{font-size:10.5px;color:#9aa4b2;margin-top:5px;max-width:270px}
    @media (max-width:900px){ #dive .map canvas{width:130px;height:130px} #dive .map .gauge,#dive .map .gauge canvas{height:130px;width:52px} }
    @media (max-width:640px){ #dive .map{display:none} }
    #dive .fade{position:absolute;inset:0;background:#02101c;pointer-events:none;transition:opacity 1.2s}
    @media (pointer:coarse){ #dive .ctl .keys{display:none} }
    #dive .ctl .brand2{display:none;margin-top:8px;text-align:right;opacity:.9}
    #dive .ctl .brand2 img{height:14px;width:auto;display:inline-block}
    #dive .hud h2 .tog{display:none;float:right;color:#9aa4b2;font-weight:400;font-size:12px}
    #dive .hud.min dl>:nth-child(-n+2),#dive .hud.min dl>:nth-child(n+5):nth-child(-n+8),#dive .hud.min dl>:nth-child(n+13),#dive .hud.min .over{display:none}
    #dive .ctl,#dive .top button{touch-action:manipulation}
    @media (max-width:1100px){ #dive .brand{display:none} #dive .ctl .brand2{display:block} #dive .hud{top:62px} #dive .note{max-width:calc(100vw - 394px)} }
    @media (max-width:640px),(max-height:520px){ #dive .hud h2{cursor:pointer} #dive .hud h2 .tog{display:inline} }
    @media (max-width:640px){
      #dive .top{top:10px;left:10px;right:10px;flex-wrap:nowrap;overflow-x:auto;justify-content:flex-start;scrollbar-width:none}
      #dive .top::-webkit-scrollbar{display:none}
      #dive .top button{flex:none;padding:7px 11px;font-size:12.5px}
      #dive .top .exit{order:-1}
      #dive .hud{width:auto;left:10px;right:10px;top:54px;padding:9px 12px;font-size:12px}
      #dive .hud h2{font-size:14px;margin-bottom:4px}
      #dive .hud dl{font-size:12px;gap:2px 10px}
      #dive .note{display:none}
      #dive .ctl{left:10px;right:10px;bottom:10px;width:auto;padding:10px 12px}
      #dive .ctl .g3 button{height:46px}
      #dive .tip{top:38%;left:10px;right:10px;transform:none;text-align:center}
    }
    @media (max-height:520px){
      #dive .map,#dive .note{display:none}
      #dive .top{top:8px;right:8px}
      #dive .top button{padding:6px 10px;font-size:12px}
      #dive .hud{top:8px;left:8px;width:290px;padding:8px 10px}
      #dive .hud h2{font-size:13px;margin-bottom:2px}
      #dive .hud dl{font-size:11.5px;gap:1px 10px}
      #dive .ctl{right:8px;bottom:8px;left:auto;width:340px;padding:8px 10px;max-height:calc(100vh - 56px);overflow:auto}
      #dive .ctl .pads{margin:4px 0;gap:10px}
      #dive .ctl .g3 button{height:36px}
      #dive .ctl .row{margin:2px 0}
      #dive .tip{top:52px}
    }
    @media (min-width:1800px) and (min-height:1000px){ #dive .hud,#dive .top,#dive .ctl,#dive .map,#dive .note,#dive .brand,#dive .tip{zoom:1.15} }
    @media (min-width:2500px) and (min-height:1350px){ #dive .hud,#dive .top,#dive .ctl,#dive .map,#dive .note,#dive .brand,#dive .tip{zoom:1.4} }
  </style>
  <canvas></canvas>
  <div class="labels"></div>
  <div class="card hud"><h2><span data-k="title">Diving in the ocean of Enceladus</span><span class="tog" aria-hidden="true">details</span></h2>
    <dl><dt>Position</dt><dd data-k="pos">—</dd>
    <dt>Below the surface</dt><dd data-k="depth">—</dd>
    <dt>Ice above you</dt><dd data-k="ice">—</dd>
    <dt>Water above you</dt><dd data-k="toice">—</dd>
    <dt>Seafloor below</dt><dd data-k="tofloor">—</dd>
    <dt>Water temperature</dt><dd data-k="temp">—</dd>
    <dt>Speed</dt><dd data-k="speed">—</dd></dl>
    <div class="over" data-k="tempsrc" style="color:#9aa4b2;font-size:11.5px"></div>
    <div class="over" data-k="over"></div></div>
  <div class="top">
    <button data-a="mode">Switch to submarine</button>
    <button data-a="vis" class="on">View: dive lights</button>
    <button data-a="stripes">Go to tiger stripes</button>
    <button data-a="exit" class="exit">Exit dive</button>
  </div>
  <div class="brand"><img src="spaceocean-wordmark-white.png" alt="Space Ocean Corp"></div>
  <div class="card map">
    <div class="head"><b>Map</b><button data-a="mapzoom">Zoom in</button></div>
    <div class="body"><canvas data-k="mapc" title="Click to travel there"></canvas><div class="gauge"><canvas data-k="gaugec"></canvas></div></div>
    <div class="cap">You are at the centre, arrow shows your heading, north is up. Orange: plume jet sources. Click the map to travel.</div>
  </div>
  <div class="card tip" data-k="tip"></div>
  <div class="card ctl">
    <div class="row"><span class="t">Go to</span><button data-g="ice">Ice ceiling</button><button data-g="mid">Mid-ocean</button><button data-g="floor">Seafloor</button></div>
    <div class="pads">
      <div class="padg"><span class="t">Move</span><div class="g3">
        <button data-m="sl" title="Slide left (Z)">⇠<small>slide</small></button><button data-m="f" title="Forward (W)">▲<small>forward</small></button><button data-m="sr" title="Slide right (C)">⇢<small>slide</small></button>
        <button data-m="u" title="Rise (Space or R)">⤒<small>rise</small></button><button data-m="b" title="Back (S)">▼<small>back</small></button><button data-m="d" title="Dive down (Shift or F)">⤓<small>dive</small></button>
      </div></div>
      <div class="padg"><span class="t">Turn</span><div class="g3">
        <button data-m="rl" title="Roll left (Q)">⟲<small>roll</small></button><button data-m="pu" title="Nose up (Up arrow)">⤴<small>nose up</small></button><button data-m="rr" title="Roll right (E)">⟳<small>roll</small></button>
        <button data-m="yl" title="Turn left (A or Left arrow)">◀<small>yaw</small></button><button data-m="pd" title="Nose down (Down arrow)">⤵<small>nose dn</small></button><button data-m="yr" title="Turn right (D or Right arrow)">▶<small>yaw</small></button>
      </div></div>
    </div>
    <div class="row"><span class="t">Speed</span><button data-s="-">−</button><span data-k="speed2" style="min-width:64px;text-align:center;font-variant-numeric:tabular-nums"></span><button data-s="+">+</button><button data-a="level" style="margin-left:auto">Level out</button></div>
    <div class="brand2"><img src="spaceocean-wordmark-white.png" alt="Space Ocean Corp"></div>
    <div class="keys"><b>Drag</b> to look · <b>W/S</b> forward/back · <b>A/D</b> turn · <b>↑/↓</b> nose up/down · <b>Q/E</b> roll · <b>Space/R</b> rise · <b>Shift/F</b> dive · <b>Z/C</b> slide · <b>L</b> level · <b>+/−</b> speed · <b>Esc</b> exit</div>
  </div>
  <div class="card note">The ice ceiling's shape comes from the selected model (${esc(model.name)}). The fractures follow the mapped jet sources. Small-scale texture and the hydrothermal vents are illustrative: no one has seen the seafloor. Under kilometres of ice it would be completely dark, so the lights are yours.</div>
  <div class="fade"></div>`;
  document.body.appendChild(root);
  // small screens: the readout shows depth, seafloor and temperature; tap its title for the rest
  { const h = root.querySelector('.hud'), t = h.querySelector('.tog'), small = matchMedia('(max-width:640px),(max-height:520px)');
    const set = m => { h.classList.toggle('min', m); t.textContent = m ? 'more ▾' : 'less ▴'; };
    set(small.matches); h.querySelector('h2').onclick = () => { if (small.matches) set(!h.classList.contains('min')); }; }
  const $ = sel => root.querySelector(sel);
  const hud = k => root.querySelector(`[data-k="${k}"]`);
  const canvas = $('canvas'), labelsEl = $('.labels');

  // ---------- three.js scene ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02101c);
  scene.fog = new THREE.FogExp2(0x02101c, 0.06);
  const camera = new THREE.PerspectiveCamera(72, 1, 0.003, 600);

  const iceMat = surfMaterial(0xcfe6f7, 0x9cc7e8, 2.2, 0.035, 0.05);
  const floorMat = surfMaterial(0x6d5643, 0x3c3029, 3.0, 0.06, 0.04);
  const ceiling = new THREE.Mesh(sphereShell(ceilingAt, 0.5), iceMat);
  const seafloor = new THREE.Mesh(sphereShell(floorAt, 0.5), floorMat);
  ceiling.frustumCulled = seafloor.frustumCulled = false;
  scene.add(ceiling, seafloor);

  // Tiger-stripe fractures: glowing slots in the ceiling along each stripe's jet sources.
  const bySulcus = {};
  jets.forEach(j => (bySulcus[j.sulcus] = bySulcus[j.sulcus] || []).push(j));
  const crackMat = new THREE.MeshBasicMaterial({ color: 0x7ee2ff, transparent: true, opacity: 0.85, fog: true });
  Object.values(bySulcus).forEach(list => {
    list.sort((a, b) => (+a.id.replace(/\D/g, '')) - (+b.id.replace(/\D/g, '')));
    // Split where neighbouring jets are far apart, so each fracture segment is drawn on its own.
    let seg = [];
    const flush = () => {
      if (seg.length < 2) { seg = []; return; }
      const pts = seg.map(j => toXYZ(j.lat, j.lon, ceilingAt(j.lat, j.lon) + 0.02));
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 12, 0.12, 6, false), crackMat);
      tube.frustumCulled = false; scene.add(tube); seg = [];
    };
    list.forEach((j, i) => {
      if (i && toXYZ(j.lat, j.lon, 1).distanceTo(toXYZ(list[i - 1].lat, list[i - 1].lon, 1)) * 230 > 25) flush();
      seg.push(j);
    });
    flush();
  });

  // Water and grains rising toward each jet source: the plumes start down here.
  const rand = rng(42);
  const plumeN = 36, plume = [];
  jets.forEach(j => {
    const top = ceilingAt(j.lat, j.lon), base = toXYZ(j.lat, j.lon, 1);
    for (let i = 0; i < plumeN; i++) plume.push({ base, top, off: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(1.2), t: rand() });
  });
  const plumeGeo = new THREE.BufferGeometry();
  const plumePos = new Float32Array(plume.length * 3);
  plumeGeo.setAttribute('position', new THREE.BufferAttribute(plumePos, 3));
  const plumePts = new THREE.Points(plumeGeo, new THREE.PointsMaterial({ color: 0xbff1ff, size: 0.05, sizeAttenuation: true, transparent: true, opacity: 0.8, fog: true }));
  plumePts.frustumCulled = false; scene.add(plumePts);

  // Illustrative hydrothermal vents on the seafloor under the south polar region.
  const vents = [], ventRand = rng(7), ventMat = new THREE.MeshBasicMaterial({ color: 0x4a3a2e, fog: true });
  const ventGlow = new THREE.MeshBasicMaterial({ color: 0xff9a3c, fog: true });
  for (let i = 0; i < 9; i++) {
    const lat = -70 - ventRand() * 18, lon = -180 + ventRand() * 360, r = floorAt(lat, lon);
    const up = toXYZ(lat, lon, 1).normalize(), h = 0.4 + ventRand() * 0.6;
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.18, h, 10, 1, true), ventMat);
    cone.position.y = h / 2; g.add(cone);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), ventGlow); tip.position.y = h; g.add(tip);
    g.position.copy(up.clone().multiplyScalar(r - 0.05));
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    scene.add(g);
    vents.push({ lat, lon, up, r, h });
  }
  const ventN = 60, ventParts = [];
  vents.forEach(v => { for (let i = 0; i < ventN; i++) ventParts.push({ v, t: Math.random(), off: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.25) }); });
  const ventGeo = new THREE.BufferGeometry(), ventPos = new Float32Array(ventParts.length * 3);
  ventGeo.setAttribute('position', new THREE.BufferAttribute(ventPos, 3));
  const ventPts = new THREE.Points(ventGeo, new THREE.PointsMaterial({ color: 0xffb070, size: 0.06, transparent: true, opacity: 0.75, fog: true }));
  ventPts.frustumCulled = false; scene.add(ventPts);

  // Drifting specks around the diver, for a sense of motion in the dark water.
  const snowN = 2500, snowBox = 3.0, snowPos = new Float32Array(snowN * 3), snowOff = new Float32Array(snowN * 3);
  for (let i = 0; i < snowN * 3; i++) snowOff[i] = (Math.random() - 0.5) * 2 * snowBox;
  const snowGeo = new THREE.BufferGeometry(); snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0x9fc4dd, size: 0.012, transparent: true, opacity: 0.6, fog: true }));
  snow.frustumCulled = false; scene.add(snow);
  // Lights for the submarine model itself (the ice and seafloor are lit in their shaders).
  scene.add(new THREE.AmbientLight(0x5a7890, 0.55));
  const subLight = new THREE.PointLight(0xffffff, 0.7, 0.4, 1.5); scene.add(subLight);
  const sub = new THREE.Group();
  {
    const hullMat = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.45, metalness: 0.2 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.6, metalness: 0.4 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, emissive: 0x2a6f9a, emissiveIntensity: 0.6, roughness: 0.1 });
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.035, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    // Built along +z (forward), +y up; units km, so the hull is about 30 m long.
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.0045, 0.02, 6, 16), hullMat); hull.rotation.x = Math.PI / 2; sub.add(hull);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.005, 0.008), hullMat); tower.position.set(0, 0.005, 0.002); sub.add(tower);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.0038, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), glassMat); dome.rotation.x = Math.PI / 2; dome.position.z = 0.0135; sub.add(dome);
    const finH = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.0006, 0.004), darkMat); finH.position.z = -0.012; sub.add(finH);
    const finV = new THREE.Mesh(new THREE.BoxGeometry(0.0006, 0.009, 0.004), darkMat); finV.position.z = -0.012; sub.add(finV);
    const prop = new THREE.Group();
    for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.0007, 0.005, 0.0004), darkMat); b.rotation.z = i * Math.PI * 2 / 3; b.position.y = 0; prop.add(b); }
    prop.position.z = -0.0165; sub.add(prop); sub.userData.prop = prop;
    [-0.003, 0.003].forEach(x => {
      const lampM = new THREE.Mesh(new THREE.SphereGeometry(0.0009, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffee })); lampM.position.set(x, -0.002, 0.016); sub.add(lampM);
      const beam = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.3, 20, 1, true), beamMat); beam.rotation.x = -Math.PI / 2; beam.position.set(x, -0.002, 0.016 + 0.15); sub.add(beam);
    });
  }
  sub.visible = false; scene.add(sub);

  // ---------- diver state ----------
  const st = {
    pos: new THREE.Vector3(), fwd: new THREE.Vector3(), pitch: 10 * D2R, roll: 0, speed: 0.4, vis: 'lights', mode: 'scuba', glide: null,
    keys: new Set(), pad: new Set(), drag: null, alive: true, last: performance.now(),
  };
  function placeAt(lat, lon) {
    const r = ceilingAt(lat, lon) - 1.2;
    st.pos.copy(toXYZ(lat, lon, r));
    const up = st.pos.clone().normalize();
    const north = new THREE.Vector3(0, 0, 1);
    st.fwd.copy(Math.abs(up.dot(north)) > 0.98 ? new THREE.Vector3(1, 0, 0) : north).addScaledVector(up, -up.dot(Math.abs(up.dot(north)) > 0.98 ? new THREE.Vector3(1, 0, 0) : north)).normalize();
    st.pitch = 12 * D2R;
  }
  placeAt(opts.lat, opts.lon);

  // ---------- feature labels on the ceiling ----------
  const labelPool = [];
  const allLabels = [
    ...feats.map(f => ({ name: f.name, sub: f.type, lat: f.lat, lon: f.lon, kind: 'f', size: f.diameter_km })),
    ...vents.map(v => ({ name: 'Hydrothermal vent', sub: 'illustrative', lat: v.lat, lon: v.lon, kind: 'v', size: 0, r: v.r + v.h + 0.2 })),
  ];
  allLabels.forEach(l => { if (l.kind === 'f') l.p = toXYZ(l.lat, l.lon, ceilingAt(l.lat, l.lon) - 0.15); else l.p = toXYZ(l.lat, l.lon, l.r); });
  function updateLabels() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cand = [];
    for (const l of allLabels) {
      const d = l.p.distanceTo(st.pos);
      const maxD = l.kind === 'v' ? 6 : Math.min(40, 8 + l.size * 0.25);
      if (d > maxD) continue;
      const v = l.p.clone().project(camera);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) continue;
      cand.push({ l, x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, d });
    }
    cand.sort((a, b) => a.d - b.d);
    cand.length = Math.min(cand.length, 14);
    while (labelPool.length < cand.length) { const e = document.createElement('div'); e.className = 'lbl'; labelsEl.appendChild(e); labelPool.push(e); }
    labelPool.forEach((e, i) => {
      const c = cand[i];
      if (!c) { e.style.display = 'none'; return; }
      e.style.display = 'block'; e.className = 'lbl' + (c.l.kind === 'v' ? ' vent' : '');
      e.style.left = c.x + 'px'; e.style.top = c.y + 'px'; e.style.opacity = Math.max(0.35, 1 - c.d / 45);
      e.innerHTML = `${esc(c.l.name)}<small>${esc(c.l.sub)} · ${c.d.toFixed(1)} km</small>`;
    });
  }


  // ---------- minimap: the moon centred on you, north up, plus a depth gauge ----------
  const mapC = hud('mapc'), gaugeC = hud('gaugec');
  const map = { zoom: 1, img: null, w: 0, h: 0, last: 0 };
  (function loadMosaic() {
    // Level-2 mosaic tiles (8 x 4 of 256 px) assembled into one equirectangular image.
    const cw = 2048, ch = 1024, off = document.createElement('canvas'); off.width = cw; off.height = ch;
    const ctx = off.getContext('2d'); let left = 32;
    for (let x = 0; x < 8; x++) for (let y = 0; y < 4; y++) {
      const im = new Image();
      im.onload = () => { ctx.drawImage(im, x * 256, y * 256); if (--left === 0) { map.img = ctx.getImageData(0, 0, cw, ch).data; map.w = cw; map.h = ch; } };
      im.onerror = () => { if (--left === 0 && !map.img) { map.img = ctx.getImageData(0, 0, cw, ch).data; map.w = cw; map.h = ch; } };
      im.src = `tiles/mosaic/2/${x}/${y}.jpg`;
    }
  })();
  function sizeCanvas(c) {
    const r = c.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, d };
  }
  // Orthographic projection centred on (lat0, lon0); zoom 1 shows the whole hemisphere.
  function project(lat, lon, lat0, lon0, R) {
    const p = lat * D2R, l = (lon - lon0) * D2R, p0 = lat0 * D2R;
    const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
    if (cosc < 0) return null;
    return { x: R * Math.cos(p) * Math.sin(l), y: R * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l)) };
  }
  function unproject(nx, ny, lat0, lon0) {
    const rho = Math.hypot(nx, ny); if (rho > 1) return null;
    const c = Math.asin(rho), p0 = lat0 * D2R;
    if (rho < 1e-9) return { lat: lat0, lon: lon0 };
    const lat = Math.asin(Math.cos(c) * Math.sin(p0) + ny * Math.sin(c) * Math.cos(p0) / rho) / D2R;
    const lon = lon0 + Math.atan2(nx * Math.sin(c), rho * Math.cos(c) * Math.cos(p0) - ny * Math.sin(c) * Math.sin(p0)) / D2R;
    return { lat, lon: ((lon + 540) % 360) - 180 };
  }
  function drawMap(ll, up) {
    if (mapC.offsetWidth < 20) return;   // the map is hidden on small screens
    const { w, h, d } = sizeCanvas(mapC), ctx = mapC.getContext('2d');
    const cx = w / 2, cy = h / 2, R = (w / 2 - 2 * d) * map.zoom;
    const img = ctx.createImageData(w, h), px = img.data;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4, dx = i - cx, dy = cy - j;
      if (dx * dx + dy * dy > (w / 2) * (w / 2)) continue;              // round window
      const nx = dx / R, ny = dy / R, rho2 = nx * nx + ny * ny;
      if (rho2 > 1) { px[k] = 2; px[k + 1] = 8; px[k + 2] = 16; px[k + 3] = 255; continue; }
      const q = unproject(nx, ny, ll.lat, ll.lon);
      let v = 60;
      if (map.img) {
        const sx = Math.min(map.w - 1, Math.max(0, Math.floor((q.lon + 180) / 360 * map.w)));
        const sy = Math.min(map.h - 1, Math.max(0, Math.floor((90 - q.lat) / 180 * map.h)));
        v = map.img[(sy * map.w + sx) * 4];
      }
      const limb = 0.55 + 0.45 * Math.sqrt(1 - rho2);
      px[k] = v * limb * 0.85; px[k + 1] = v * limb * 0.93; px[k + 2] = v * limb; px[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Plume jet sources.
    ctx.fillStyle = '#ff9a3c';
    jets.forEach(jt => { const q = project(jt.lat, jt.lon, ll.lat, ll.lon, R); if (q && Math.hypot(q.x, q.y) < w / 2 - 3 * d) { ctx.beginPath(); ctx.arc(cx + q.x, cy - q.y, 1.6 * d, 0, 7); ctx.fill(); } });
    // Graticule hint: the equator and the poles if in view.
    ctx.strokeStyle = 'rgba(138,180,248,.35)'; ctx.lineWidth = d; ctx.beginPath(); let pen = false;
    for (let lo = -180; lo <= 180; lo += 3) { const q = project(0, lo, ll.lat, ll.lon, R); if (q && Math.hypot(q.x, q.y) < w / 2) { pen ? ctx.lineTo(cx + q.x, cy - q.y) : ctx.moveTo(cx + q.x, cy - q.y); pen = true; } else pen = false; }
    ctx.stroke();
    [[90, 'N'], [-90, 'S']].forEach(([la, t]) => { const q = project(la, 0, ll.lat, ll.lon, R); if (q && Math.hypot(q.x, q.y) < w / 2 - 8 * d) { ctx.fillStyle = 'rgba(207,227,245,.8)'; ctx.font = `${10 * d}px Inter,sans-serif`; ctx.textAlign = 'center'; ctx.fillText(t, cx + q.x, cy - q.y + 4 * d); } });
    // You: a dot with a heading arrow (angle from local north).
    const north = new THREE.Vector3(0, 0, 1).addScaledVector(up, -up.z);
    const east = new THREE.Vector3().crossVectors(north.lengthSq() > 1e-6 ? north.normalize() : new THREE.Vector3(1, 0, 0), up);
    let hd = Math.atan2(st.fwd.dot(east), st.fwd.dot(north.lengthSq() > 1e-6 ? north : new THREE.Vector3(1, 0, 0)));
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(hd);
    ctx.fillStyle = '#8ab4f8'; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 1.5 * d;
    ctx.beginPath(); ctx.moveTo(0, -11 * d); ctx.lineTo(6 * d, 6 * d); ctx.lineTo(0, 2.5 * d); ctx.lineTo(-6 * d, 6 * d); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // Rim.
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(cx, cy, w / 2 - d, 0, 7); ctx.stroke();
  }
  function drawGauge(sKm, ceil, floor, r) {
    const { w, h, d } = sizeCanvas(gaugeC), ctx = gaugeC.getContext('2d');
    const ice = sKm - ceil, sea = sKm - floor, depth = sKm - r, total = sea + 12;
    const Y = km => 6 * d + (h - 12 * d) * km / total, bx = 6 * d, bw = 16 * d;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#05070b'; ctx.fillRect(bx, Y(0), bw, Y(total) - Y(0));
    ctx.fillStyle = '#e8f1f8'; ctx.fillRect(bx, Y(0), bw, Y(ice) - Y(0));
    ctx.fillStyle = '#2a6fb5'; ctx.fillRect(bx, Y(ice), bw, Y(sea) - Y(ice));
    ctx.fillStyle = '#8a6a4e'; ctx.fillRect(bx, Y(sea), bw, Y(total) - Y(sea));
    ctx.font = `${9.5 * d}px Inter,sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = '#9aa4b2';
    // Labels keep at least one line apart, so thin ice doesn't stack them on top of each other.
    let ly = -1e9;
    const lab = (km, t) => { const y = Math.min(h - 3 * d, Math.max(10 * d, Y(km) + 3.5 * d, ly + 11 * d)); ctx.fillText(t, bx + bw + 4 * d, y); ly = y; };
    lab(0, 'surface'); lab(ice, 'ice base'); lab(sea, 'seafloor');
    // You.
    ctx.fillStyle = '#ffd36b'; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = d;
    ctx.beginPath(); ctx.moveTo(bx - 4 * d, Y(depth) - 4 * d); ctx.lineTo(bx + 2 * d, Y(depth)); ctx.lineTo(bx - 4 * d, Y(depth) + 4 * d); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillRect(bx, Y(depth) - 0.75 * d, bw, 1.5 * d);
  }
  mapC.addEventListener('click', e => {
    const r = mapC.getBoundingClientRect(), Rcss = (r.width / 2 - 2) * map.zoom;
    const nx = (e.clientX - r.left - r.width / 2) / Rcss, ny = (r.top + r.height / 2 - e.clientY) / Rcss;
    const here = toLL(st.pos), q = unproject(nx, ny, here.lat, here.lon);
    if (q) fade(() => placeAt(q.lat, q.lon));
  });
  root.querySelector('[data-a="mapzoom"]').onclick = e => { map.zoom = map.zoom === 1 ? 4 : 1; e.target.textContent = map.zoom === 1 ? 'Zoom in' : 'Whole moon'; map.last = 0; };

  // ---------- input ----------
  const onKey = (e, down) => {
    const k = e.key.toLowerCase();
    if (down && k === 'escape') return stop();
    if (down && (k === '+' || k === '=')) st.speed = Math.min(st.speed * 1.5, 20);
    if (down && (k === '-' || k === '_')) st.speed = Math.max(st.speed / 1.5, 0.02);
    if (down && k === 'l') levelOut();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'shift', 'e', 'q', 'r', 'f', 'z', 'c'].includes(k)) {
      down ? st.keys.add(k) : st.keys.delete(k); e.preventDefault();
    }
  };
  const kd = e => onKey(e, true), ku = e => onKey(e, false);
  window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
  canvas.addEventListener('pointerdown', e => { st.drag = { x: e.clientX, y: e.clientY }; try { canvas.setPointerCapture(e.pointerId); } catch (_) {} });
  canvas.addEventListener('pointermove', e => {
    if (!st.drag) return;
    const dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y; st.drag = { x: e.clientX, y: e.clientY };
    const up = st.pos.clone().normalize();
    st.fwd.applyAxisAngle(up, -dx * 0.004);
    st.pitch = Math.max(-1.45, Math.min(1.45, st.pitch - dy * 0.004));
  });
  const endDrag = () => { st.drag = null; };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', e => { st.speed = Math.max(0.02, Math.min(20, st.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); e.preventDefault(); }, { passive: false });
  // Hold a pad button to keep moving or turning.
  root.querySelectorAll('.ctl [data-m]').forEach(b => {
    const on = e => { st.pad.add(b.dataset.m); b.classList.add('held'); try { b.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); };
    const off = () => { st.pad.delete(b.dataset.m); b.classList.remove('held'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
  });
  root.querySelectorAll('.ctl [data-g]').forEach(b => b.onclick = () => { st.glide = b.dataset.g; });
  root.querySelectorAll('.ctl [data-s]').forEach(b => b.onclick = () => { st.speed = b.dataset.s === '+' ? Math.min(st.speed * 1.5, 20) : Math.max(st.speed / 1.5, 0.02); });
  function levelOut() { st.pitch = 0; st.roll = 0; }
  root.querySelector('[data-a="level"]').onclick = levelOut;
  root.querySelector('[data-a="exit"]').onclick = () => stop();
  function setMode(m) {
    st.mode = m; sub.visible = m === 'sub';
    st.speed = m === 'sub' ? Math.max(st.speed, 1.5) : Math.min(st.speed, 0.6);
    root.querySelector('[data-a="mode"]').textContent = m === 'sub' ? 'Switch to scuba' : 'Switch to submarine';
    hud('title').textContent = m === 'sub' ? 'Submarine in the ocean of Enceladus' : 'Diving in the ocean of Enceladus';
    setVis(st.vis);
  }
  const VIS = { lights: 'View: dive lights', sonar: 'View: sonar', dark: 'View: real darkness' };
  function setVis(v) {
    st.vis = v;
    const b = root.querySelector('[data-a="vis"]');
    b.textContent = v === 'lights' && st.mode === 'sub' ? 'View: sub lights' : VIS[v];
    b.classList.toggle('on', v !== 'dark');
    scene.fog.density = v === 'sonar' ? 0.01 : 0.06;
  }
  root.querySelector('[data-a="mode"]').onclick = () => setMode(st.mode === 'sub' ? 'scuba' : 'sub');
  root.querySelector('[data-a="vis"]').onclick = () => setVis(st.vis === 'lights' ? 'sonar' : st.vis === 'sonar' ? 'dark' : 'lights');
  root.querySelector('[data-a="stripes"]').onclick = () => { fade(() => placeAt(-84, -60)); };
  const fadeEl = $('.fade');
  function fade(fn) { fadeEl.style.opacity = 1; setTimeout(() => { fn(); fadeEl.style.opacity = 0; }, 450); }

  function resize() {
    const w = root.clientWidth, h = root.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize); resize();

  // ---------- loop ----------
  let hudT = 0;
  function frame(now) {
    if (!st.alive) return;
    const dt = Math.min((now - st.last) / 1000, 0.1); st.last = now;
    const up = st.pos.clone().normalize();
    st.fwd.addScaledVector(up, -st.fwd.dot(up)).normalize();       // keep heading level as we travel round
    const has = (...k) => k.some(x => st.keys.has(x)), pad = m => st.pad.has(m);
    // Turning: yaw about the local vertical, pitch the nose, roll about the view.
    const yaw = (has('a', 'arrowleft') || pad('yl') ? 1 : 0) - (has('d', 'arrowright') || pad('yr') ? 1 : 0);
    const pit = (has('arrowup') || pad('pu') ? 1 : 0) - (has('arrowdown') || pad('pd') ? 1 : 0);
    const rol = (has('e') || pad('rr') ? 1 : 0) - (has('q') || pad('rl') ? 1 : 0);
    if (yaw) st.fwd.applyAxisAngle(up, yaw * 55 * D2R * dt);
    st.pitch = Math.max(-1.5, Math.min(1.5, st.pitch + pit * 45 * D2R * dt));
    st.roll = ((st.roll + rol * 60 * D2R * dt + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const look = st.fwd.clone().multiplyScalar(Math.cos(st.pitch)).addScaledVector(up, Math.sin(st.pitch)).normalize();
    const right = new THREE.Vector3().crossVectors(look, up).normalize().applyAxisAngle(look, st.roll);
    const camUp = new THREE.Vector3().crossVectors(right, look).normalize();
    // Moving: forward/back along the view, slide sideways, rise/dive straight up or down.
    const mv = new THREE.Vector3();
    if (has('w') || pad('f')) mv.add(look);
    if (has('s') || pad('b')) mv.sub(look);
    if (has('c') || pad('sr')) mv.add(right);
    if (has('z') || pad('sl')) mv.sub(right);
    const vert = (has(' ', 'r') || pad('u') ? 1 : 0) - (has('shift', 'f') || pad('d') ? 1 : 0);
    if (vert) { mv.addScaledVector(up, vert); st.glide = null; }
    if (mv.lengthSq() > 0) st.pos.addScaledVector(mv.normalize(), st.speed * dt);
    // Stay in the water: below the ice, above the seafloor.
    const ll = toLL(st.pos), ceil = ceilingAt(ll.lat, ll.lon), floor = floorAt(ll.lat, ll.lon);
    const clear = st.mode === 'sub' ? 0.06 : 0.12;
    let r = Math.min(Math.max(ll.r, floor + clear), ceil - clear);
    // Go to: glide up or down to the ice ceiling, mid-ocean or the seafloor.
    if (st.glide) {
      const target = st.glide === 'ice' ? ceil - 0.6 : st.glide === 'floor' ? floor + 0.6 : (ceil + floor) / 2;
      const step = Math.max(6, st.speed * 4) * dt, dr = target - r;
      if (Math.abs(dr) <= step) {
        r = target;
        if (st.glide === 'floor') st.pitch = -25 * D2R; else if (st.glide === 'ice') st.pitch = 30 * D2R;
        st.glide = null;
      } else r += Math.sign(dr) * step;
    }
    st.pos.setLength(r);

    camera.up.copy(camUp);
    let lampPos = st.pos;
    if (st.mode === 'sub') {
      sub.position.copy(st.pos);
      const m4 = new THREE.Matrix4().makeBasis(right.clone().negate(), camUp, look);
      sub.quaternion.setFromRotationMatrix(m4);
      sub.userData.prop.rotation.z += dt * (mv.lengthSq() > 0 ? 25 : 3);
      camera.position.copy(st.pos).addScaledVector(look, -0.075).addScaledVector(camUp, 0.022);
      camera.lookAt(st.pos.clone().addScaledVector(look, 0.05));
      lampPos = st.pos.clone().addScaledVector(look, 0.02);
      subLight.position.copy(camera.position).addScaledVector(camUp, 0.01);
    } else {
      camera.position.copy(st.pos);
      camera.lookAt(st.pos.clone().add(look));
    }
    // Dive lights: lamps and murky water. Sonar: see tens of km (an enhanced view, not what eyes would see).
    const vis = st.vis, lampOn = vis === 'dark' ? 0 : vis === 'sonar' ? 0.6 : 1;
    [iceMat, floorMat].forEach(m => {
      m.uniforms.uCam.value.copy(camera.position); m.uniforms.uLight.value.copy(lampPos); m.uniforms.uLampDir.value.copy(look); m.uniforms.uLamp.value = lampOn;
      m.uniforms.uAmbient.value = vis === 'sonar' ? (m === iceMat ? 0.5 : 0.85) : vis === 'lights' ? (m === iceMat ? 0.05 : 0.04) : 0.004;
      m.uniforms.uFog.value = vis === 'sonar' ? 0.00012 : 0.0035;
    });

    // Particles.
    for (let i = 0; i < plume.length; i++) {
      const p = plume[i]; p.t += dt * 0.12; if (p.t > 1) p.t -= 1;
      const rr = p.top - 2.5 + 2.5 * p.t, q = p.base.clone().multiplyScalar(rr).add(p.off.clone().multiplyScalar(1 - p.t));
      plumePos[i * 3] = q.x; plumePos[i * 3 + 1] = q.y; plumePos[i * 3 + 2] = q.z;
    }
    plumeGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < ventParts.length; i++) {
      const p = ventParts[i]; p.t += dt * 0.25; if (p.t > 1) p.t -= 1;
      const q = p.v.up.clone().multiplyScalar(p.v.r + p.v.h + p.t * 1.6).add(p.off.clone().multiplyScalar(1 + 3 * p.t));
      ventPos[i * 3] = q.x; ventPos[i * 3 + 1] = q.y; ventPos[i * 3 + 2] = q.z;
    }
    ventGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < snowN; i++) for (let a = 0; a < 3; a++) {
      const c = st.pos.getComponent(a);
      let v = snowOff[i * 3 + a] - c; v = ((v + snowBox) % (2 * snowBox) + 2 * snowBox) % (2 * snowBox) - snowBox;
      snowPos[i * 3 + a] = c + v;
    }
    snowGeo.attributes.position.needsUpdate = true;

    renderer.render(scene, camera);
    updateLabels();

    if (now - hudT > 150) {
      hudT = now;
      const s = surfAt(ll.lat, ll.lon);
      hud('pos').textContent = `${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? 'N' : 'S'}, ${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? 'E' : 'W'}`;
      hud('depth').textContent = (s - r).toFixed(1) + ' km';
      hud('ice').textContent = (s - ceil).toFixed(1) + ' km thick';
      hud('toice').textContent = (ceil - r).toFixed(2) + ' km';
      hud('tofloor').textContent = (r - floor).toFixed(1) + ' km';
      // Temperature at this depth; within 1.5 km of an illustrative vent, say what vent water reaches.
      let nearVent = vents.some(v => st.pos.distanceTo(v.up.clone().multiplyScalar(v.r + v.h)) < 1.5);
      const T = tempAt(s - r, ll.lat, ll.lon);
      hud('temp').textContent = nearVent ? 'warmer near the vent' : T.text;
      hud('tempsrc').textContent = nearVent ? 'Vent water: above 90 °C where it leaves the seafloor (Hsu et al. 2015). The vent itself is illustrative.' : T.source;
      const spTxt = st.speed < 1 ? (st.speed * 1000).toFixed(0) + ' m/s' : st.speed.toFixed(1) + ' km/s';
      hud('speed2').textContent = spTxt;
      const tip = hud('tip');
      const tipTxt = st.glide ? `Heading to the ${st.glide === 'ice' ? 'ice ceiling' : st.glide === 'floor' ? 'seafloor' : 'middle of the ocean'}…`
        : (st.vis !== 'sonar' && ceil - r > 4 && r - floor > 4) ? 'Too dark to see the ice or the seafloor from here. Try View: sonar, or Go to: Seafloor.' : '';
      tip.textContent = tipTxt; tip.classList.toggle('open', !!tipTxt);
      hud('speed').textContent = st.speed < 1 ? (st.speed * 1000).toFixed(0) + ' m/s' : st.speed.toFixed(1) + ' km/s';
      if (now - map.last > 250) { map.last = now; if (mapC.offsetWidth >= 20) { drawMap(ll, up); drawGauge(s, ceil, floor, r); } }
      let best = null, bd = 1e9;
      feats.forEach(f => { const d = toXYZ(f.lat, f.lon, 1).angleTo(up) * s; if (d < bd) { bd = d; best = f; } });
      hud('over').textContent = best ? (bd < Math.max(best.diameter_km / 2, 5) ? `Overhead: ${best.name} (${best.type})` : `Nearest named feature: ${best.name}, ${bd.toFixed(0)} km away`) : '';
    }
    requestAnimationFrame(frame);
  }
  setMode(opts.mode === 'sub' ? 'sub' : 'scuba');
  fadeEl.style.opacity = 1; requestAnimationFrame(t => { st.last = t; fadeEl.style.opacity = 0; requestAnimationFrame(frame); });

  function stop() {
    if (!st.alive) return;
    st.alive = false;
    window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('resize', resize);
    const ll = toLL(st.pos);
    renderer.dispose(); scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    root.remove();
    onExit && onExit(ll.lat, ll.lon);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  return { stop };
}
