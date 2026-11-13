// 3D vehicle preview: the car is split into parts (front, rear, side mirrors, cabin, chassis);
// a part with an active condition is highlighted in the colour of its most severe level, taken
// from state.vehicleParts (computed by the engine). The part list next to the canvas shows the
// same information as text. It does not depend on three.js, so it keeps working when WebGL is
// not available, when three.js cannot be loaded, or while the WebGL context is lost.

const LEVEL_COLOR = { critical: 0xef4444, fault: 0xa855f7, warning: 0xf59e0b, info: 0x38bdf8 };
const LABEL_ORDER = ['ok', 'info', 'warning', 'fault', 'critical']; // least to most severe
const LEVEL_INTENSITY = { critical: 0.85, fault: 0.6, warning: 0.6, info: 0.3 };
const STATUS_LABEL = {
  NORMAL: '正常', WARNING: '警示', EMERGENCY: '緊急', STANDBY: '待機', SHED: '已卸載', DEFERRED: '延後啟動', FAULT: '故障',
};
const FALLBACK_TEXT = {
  webgl: '這個瀏覽器無法顯示 3D 畫面（WebGL 不可用），請看部位狀態清單。',
  load: '3D 元件載入失敗，無法顯示 3D 畫面，請看部位狀態清單。',
  lost: '3D 畫面暫時中斷，正在嘗試恢復；請先看部位狀態清單。',
  stuck: '3D 畫面中斷後沒有恢復，請看部位狀態清單，或重新整理頁面。',
};
const LOST_GIVE_UP_MS = 5000; // after this long without a restored context, stop saying it is recovering

// Label anchor and camera preset for every part (+Z is the front of the car, +X its left side).
// `probes` are the points tested for occlusion (default: the anchor). A label is dimmed only when
// every probe is hidden behind another part: the mirror is tested at its body, below the label
// that stays visible above the windshield; the chassis, which spans the whole car, at the outer
// side of its four wheels and both side skirts, so it counts as visible while any of them is.
const PART_VIEW = {
  front: { anchor: [0, 1.35, 2.15], cam: [2.8, 2.0, 4.4], target: [0, 0.85, 1.45] },
  rear: { anchor: [0, 1.38, -2.15], cam: [-2.8, 2.0, -4.4], target: [0, 0.85, -1.45] },
  mirror_left: { anchor: [1.18, 1.32, 0.62], probes: [[1.15, 0.99, 0.62]], cam: [2.7, 1.65, 1.9], target: [1.05, 1.05, 0.62] },
  mirror_right: { anchor: [-1.18, 1.32, 0.62], probes: [[-1.15, 0.99, 0.62]], cam: [-2.7, 1.65, 1.9], target: [-1.05, 1.05, 0.62] },
  cabin: { anchor: [0, 1.62, -0.15], cam: [3.2, 3.4, 0.6], target: [0, 1.1, -0.15] },
  chassis: {
    anchor: [0.98, 0.5, -1.35],
    probes: [[1.06, 0.38, 1.35], [-1.06, 0.38, 1.35], [1.06, 0.38, -1.35], [-1.06, 0.38, -1.35], [0.97, 0.34, -0.05], [-0.97, 0.34, -0.05]],
    cam: [3.6, 0.9, -2.6],
    target: [0, 0.4, -0.6],
  },
};
const DEFAULT_CAM = [4.5, 2.8, 4.8];
const DEFAULT_TARGET = [0, 0.8, 0];
const LABEL_MARGIN = 4; // px kept free between a label and the edge of the viewport

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const view = {
  parts: [],          // latest state.vehicleParts
  partsKey: '',       // serialised parts, to skip state pushes that change nothing here
  selected: null,
  hovered: null,
  groups: {},         // part id -> THREE.Group
  meshes: [],         // raycast targets
  labels: {},         // part id -> label element
  rows: {},           // part id -> list button
  webgl: false,       // the 3D scene is running
  contextLost: false, // the WebGL context is lost (the GPU was reset); three.js restores it
  visible: true,
  dirty: true,        // the scene must be drawn again
  frames: 0,          // frames drawn so far (exposed for tests)
  camAnimating: false,
  camPos: null,
  camTarget: null,
};
// three.js is loaded on demand (see boot), so these are only set once the scene exists.
let THREE; let OrbitControls;
let scene; let camera; let renderer; let controls; let ring; let ground; let raycaster; let pointer;

// ------------------------------------------------------------------ model
function mat(color, roughness = 0.3, metalness = 0.6, emissive = 0x000000, emissiveIntensity = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}
function box(w, h, d, material, [x, y, z], rotX = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.rotation.x = rotX;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function part(id, root) {
  const g = new THREE.Group();
  g.name = id;
  root.add(g);
  view.groups[id] = g;
  return g;
}

// Lamps, the sensor module and the mirror LEDs use dim neutral colours: with the status colours
// (red, amber, blue) they would look highlighted on a part that has no condition.
function buildCar(root) {
  const paint = () => mat(0x334155, 0.28, 0.72);
  const glass = () => mat(0x0f172a, 0.1, 0.9);
  const trim = () => mat(0x1e293b, 0.6, 0.3);

  // Cabin: roof and windows (eCall, display, HVAC, seats, power budget).
  const cabin = part('cabin', root);
  cabin.add(box(1.56, 0.52, 1.55, paint(), [0, 1.14, -0.15]));
  cabin.add(box(1.59, 0.38, 1.38, glass(), [0, 1.13, -0.15]));

  // Chassis and powertrain: lower body, side skirts and wheels (trip computer, alternator).
  const chassis = part('chassis', root);
  chassis.add(box(1.86, 0.56, 2.2, paint(), [0, 0.62, -0.05]));
  chassis.add(box(1.92, 0.12, 2.15, trim(), [0, 0.34, -0.05]));
  const tire = mat(0x0f172a, 0.85, 0.1);
  const rim = mat(0x94a3b8, 0.25, 0.85);
  for (const [x, z] of [[0.92, 1.35], [-0.92, 1.35], [0.92, -1.35], [-0.92, -1.35]]) {
    const w = new THREE.Group();
    w.position.set(x, 0.38, z);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.26, 28), tire.clone());
    t.rotation.z = Math.PI / 2;
    t.castShadow = true;
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.27, 16), rim.clone());
    r.rotation.z = Math.PI / 2;
    w.add(t, r);
    chassis.add(w);
  }

  // Front: hood, windshield, bumper, grille, front sensor module, headlights.
  const front = part('front', root);
  front.add(box(1.84, 0.48, 1.15, mat(0x475569, 0.25, 0.75), [0, 0.66, 1.62]));
  front.add(box(1.24, 0.08, 1.02, mat(0x64748b, 0.25, 0.75), [0, 0.91, 1.56], 0.06));
  front.add(box(1.52, 0.54, 0.08, mat(0x1e293b, 0.1, 0.92), [0, 1.13, 0.82], -0.56));
  front.add(box(1.92, 0.34, 0.32, mat(0x1e293b, 0.45, 0.4), [0, 0.44, 2.15]));
  front.add(box(1.02, 0.28, 0.08, mat(0x0f172a, 0.4, 0.7), [0, 0.62, 2.21]));
  front.add(box(0.18, 0.14, 0.09, mat(0x334155, 0.3, 0.8), [0, 0.58, 2.22]));
  for (const x of [0.68, -0.68]) front.add(box(0.36, 0.12, 0.14, mat(0xe2e8f0, 0.1, 0.2, 0xf8fafc, 0.15), [x, 0.72, 2.16]));

  // Rear: trunk, rear window (defroster), spoiler, bumper, tail light, rear camera.
  const rear = part('rear', root);
  rear.add(box(1.84, 0.54, 1.02, mat(0x475569, 0.25, 0.75), [0, 0.68, -1.65]));
  rear.add(box(1.5, 0.5, 0.08, mat(0x1e293b, 0.1, 0.92), [0, 1.14, -1.08], 0.55));
  rear.add(box(1.62, 0.06, 0.22, mat(0x1e293b, 0.3, 0.7), [0, 0.98, -2.08]));
  rear.add(box(1.92, 0.34, 0.3, mat(0x1e293b, 0.45, 0.4), [0, 0.44, -2.1]));
  rear.add(box(1.74, 0.11, 0.1, mat(0x4c1d24, 0.3, 0.3), [0, 0.8, -2.14]));
  rear.add(box(0.16, 0.08, 0.08, mat(0x0f172a, 0.2, 0.8), [0, 0.66, -2.16]));

  // Side mirrors with the blind-spot LED (side 1 = left, +X).
  for (const [id, side] of [['mirror_left', 1], ['mirror_right', -1]]) {
    const g = part(id, root);
    g.position.set(side * 0.93, 0.96, 0.62);
    g.add(box(0.18, 0.07, 0.1, mat(0x1e293b, 0.4, 0.6), [side * 0.08, 0, 0]));
    g.add(box(0.26, 0.16, 0.18, mat(0x64748b, 0.22, 0.75), [side * 0.22, 0.03, 0]));
    g.add(box(0.22, 0.13, 0.02, mat(0xe2e8f0, 0.05, 0.98), [side * 0.22, 0.03, -0.085]));
    g.add(box(0.2, 0.03, 0.02, mat(0x475569, 0.3, 0.5), [side * 0.22, 0.03, 0.088]));
  }

  for (const [id, g] of Object.entries(view.groups)) {
    g.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.partId = id;
      o.userData.emissive = o.material.emissive.clone();
      o.userData.emissiveIntensity = o.material.emissiveIntensity;
      view.meshes.push(o);
    });
  }
}

// ------------------------------------------------------------------ scene
function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  try { return new THREE.Color(v || fallback); } catch { return new THREE.Color(fallback); }
}

function applyTheme() {
  if (!scene) return;
  const bg = cssColor('--v3d-bg', '#0b0f19');
  scene.background = bg;
  scene.fog.color = bg;
  if (ground) ground.material.color.copy(cssColor('--v3d-ground', '#0f172a'));
  view.dirty = true;
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (err) {
    return false;
  }
}

function initScene(viewport) {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (err) {
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  viewport.prepend(renderer.domElement);

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  view.camPos = new THREE.Vector3(...DEFAULT_CAM);
  view.camTarget = new THREE.Vector3(...DEFAULT_TARGET);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b0f19, 0.04);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(...DEFAULT_CAM);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.03;
  controls.minDistance = 2.2;
  controls.maxDistance = 14;
  controls.target.set(...DEFAULT_TARGET);
  controls.addEventListener('start', () => { view.camAnimating = false; });
  controls.addEventListener('change', () => { view.dirty = true; });

  // Light intensities are physical (three.js r155+), hence the factor of π compared with legacy units.
  scene.add(new THREE.AmbientLight(0xdbeafe, 1.6));
  const hemi = new THREE.HemisphereLight(0x93c5fd, 0x1e293b, 1.9);
  hemi.position.set(0, 10, 0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 4);
  sun.position.set(5, 8, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { near: 1, far: 25, left: -5, right: 5, top: 5, bottom: -5 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x38bdf8, 2.2);
  rim.position.set(-5, 4, -5);
  scene.add(rim);

  ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.85, metalness: 0.15 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  applyTheme();
  const grid = new THREE.GridHelper(24, 36, 0x1e3a8a, 0x1e293b);
  grid.position.y = 0.005;
  scene.add(grid);
  ring = new THREE.Mesh(new THREE.RingGeometry(2.55, 2.62, 64), new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.35 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  const root = new THREE.Group();
  scene.add(root);
  buildCar(root);

  const resize = () => {
    const w = viewport.clientWidth || 1;
    const h = viewport.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    view.dirty = true;
  };
  new ResizeObserver(resize).observe(viewport);
  resize();

  // A press that does not move is a click (a drag rotates the view).
  let down = null;
  const pick = (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(view.meshes, false)[0];
    return hit ? hit.object.userData.partId : null;
  };
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    select(pick(e));
  });
  renderer.domElement.addEventListener('pointermove', (e) => setHovered(pick(e)));
  renderer.domElement.addEventListener('pointerleave', () => setHovered(null));

  // When the GPU is reset the context is lost: show the fallback text until three.js restores it.
  // If the browser does not restore it within LOST_GIVE_UP_MS, the text stops promising recovery.
  let lostTimer = null;
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // allows the browser to restore the context
    view.contextLost = true;
    showFallback(viewport, 'lost');
    renderUi();
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => { if (view.contextLost) showFallback(viewport, 'stuck'); }, LOST_GIVE_UP_MS);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    clearTimeout(lostTimer);
    view.contextLost = false;
    hideFallback(viewport);
    view.dirty = true;
    renderUi();
  });

  new IntersectionObserver((entries) => {
    view.visible = entries.some((x) => x.isIntersecting);
    view.dirty = true;
  }).observe(viewport);
  document.addEventListener('visibilitychange', invalidate);
  reduceMotion.addEventListener('change', invalidate);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  return true;
}

// ------------------------------------------------------------------ highlight
function levelOf(id) {
  const p = view.parts.find((x) => x.id === id);
  return p ? p.level : 'ok';
}

function updateHighlight(time) {
  const pulse = reduceMotion.matches ? 1 : 0.55 + 0.45 * Math.sin(time * 0.0075);
  for (const [id, g] of Object.entries(view.groups)) {
    const level = levelOf(id);
    const color = LEVEL_COLOR[level];
    const boost = (view.hovered === id ? 0.15 : 0) + (view.selected === id ? 0.15 : 0);
    g.traverse((o) => {
      if (!o.isMesh) return;
      if (color !== undefined) {
        o.material.emissive.setHex(color);
        o.material.emissiveIntensity = LEVEL_INTENSITY[level] * (level === 'critical' ? pulse : 1) + boost;
      } else if (boost) {
        o.material.emissive.setHex(0x38bdf8);
        o.material.emissiveIntensity = boost;
      } else {
        o.material.emissive.copy(o.userData.emissive);
        o.material.emissiveIntensity = o.userData.emissiveIntensity;
      }
    });
  }
  // The ring under the car follows the most severe part.
  const worst = ['critical', 'fault', 'warning'].find((l) => view.parts.some((p) => p.level === l));
  ring.material.color.setHex(worst ? LEVEL_COLOR[worst] : 0x38bdf8);
  ring.material.opacity = worst === 'critical' ? 0.25 + 0.4 * pulse : 0.35;
}

// Whether a point of a part is hidden behind another part of the car from the camera.
function hiddenPoint(id, point) {
  const dir = point.clone().sub(camera.position);
  const dist = dir.length();
  raycaster.set(camera.position, dir.normalize());
  raycaster.far = dist;
  const hit = raycaster.intersectObjects(view.meshes, false).find((h) => h.object.userData.partId !== id);
  raycaster.far = Infinity;
  return !!hit;
}

// A part counts as hidden only when all of its probe points are hidden.
function occluded(id) {
  const pv = PART_VIEW[id];
  return (pv.probes || [pv.anchor]).every((p) => hiddenPoint(id, new THREE.Vector3(...p)));
}

function placeLabels(viewport) {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  const shown = [];
  for (const [id, el] of Object.entries(view.labels)) {
    const anchor = new THREE.Vector3(...PART_VIEW[id].anchor);
    const v = anchor.clone().project(camera);
    if (v.z > 1) { el.hidden = true; continue; }
    el.hidden = false;
    el.classList.toggle('occluded', occluded(id));
    shown.push({ id, el, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h });
  }
  // A label is kept inside the viewport (its box is centred on x and ends at y). Labels that would
  // overlap are moved up or down by a row; the selected part and the most severe parts keep their
  // place.
  const rank = (id) => (id === view.selected ? -10 : 0) - LABEL_ORDER.indexOf(levelOf(id));
  shown.sort((a, b) => rank(a.id) - rank(b.id));
  for (const l of shown) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi));
  const placed = [];
  const hits = (l, y) => placed.some((p) => Math.abs(p.x - l.x) < (p.w + l.w) / 2 + 2 && Math.abs(p.y - y) < (p.h + l.h) / 2 + 2);
  for (const l of shown) {
    l.x = clamp(l.x, l.w / 2 + LABEL_MARGIN, w - l.w / 2 - LABEL_MARGIN);
    const fit = (y) => clamp(y, l.h + LABEL_MARGIN, h - LABEL_MARGIN);
    const step = l.h + 4;
    const y = [0, -step, step, -2 * step, 2 * step].map((d) => fit(l.y + d)).find((c) => !hits(l, c));
    l.y = y !== undefined ? y : fit(l.y);
    placed.push(l);
    l.el.style.left = `${l.x}px`;
    l.el.style.top = `${l.y}px`;
  }
}

// The scene is only drawn when something changed (state, hover, selection, size, camera), so an
// idle dashboard does not keep the GPU (or a software renderer) busy. A critical part pulses at
// about 20 frames per second, and not at all when the user prefers reduced motion.
const PULSE_FRAME_MS = 50;
let lastPulseFrame = 0;
function invalidate() { view.dirty = true; }

function loop(viewport) {
  requestAnimationFrame((t) => {
    if (view.visible && !document.hidden && !view.contextLost) {
      if (view.camAnimating) {
        camera.position.lerp(view.camPos, 0.08);
        controls.target.lerp(view.camTarget, 0.08);
        if (camera.position.distanceTo(view.camPos) < 0.02 && controls.target.distanceTo(view.camTarget) < 0.02) view.camAnimating = false;
        view.dirty = true;
      }
      if (controls.update()) view.dirty = true; // true while the damped rotation is still moving
      const pulsing = !reduceMotion.matches && view.parts.some((p) => p.level === 'critical');
      if (pulsing && t - lastPulseFrame >= PULSE_FRAME_MS) view.dirty = true;
      if (view.dirty) {
        view.dirty = false;
        lastPulseFrame = t;
        updateHighlight(t);
        placeLabels(viewport);
        renderer.render(scene, camera);
        view.frames += 1;
      }
    }
    loop(viewport);
  });
}

// ------------------------------------------------------------------ UI (labels, part list, detail)
function showFallback(viewport, reason) {
  const fb = $('#v3dFallback');
  fb.textContent = FALLBACK_TEXT[reason];
  viewport.dataset.fallback = reason;
  fb.hidden = false;
  viewport.classList.add('no-webgl');
  $('#v3dReset').hidden = true;
  viewport.querySelector('.v3d-hint').hidden = true;
  $('#v3dLabels').hidden = true;
}

function hideFallback(viewport) {
  $('#v3dFallback').hidden = true;
  delete viewport.dataset.fallback;
  viewport.classList.remove('no-webgl');
  $('#v3dReset').hidden = false;
  viewport.querySelector('.v3d-hint').hidden = false;
  $('#v3dLabels').hidden = false;
}

// The part list works on its own, before (and without) the 3D scene.
function buildList() {
  const list = $('#v3dParts');
  for (const id of Object.keys(PART_VIEW)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'v3d-row';
    row.dataset.part = id;
    row.innerHTML = '<span class="v3d-dot" aria-hidden="true"></span><span class="v3d-name"></span><span class="v3d-level"></span><span class="v3d-sum"></span>';
    row.addEventListener('click', () => select(view.selected === id ? null : id));
    row.addEventListener('mouseenter', () => setHovered(id));
    row.addEventListener('mouseleave', () => setHovered(null));
    list.appendChild(row);
    view.rows[id] = row;
  }
}

function buildLabels() {
  const labels = $('#v3dLabels');
  for (const id of Object.keys(PART_VIEW)) {
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'v3d-label';
    tag.dataset.part = id;
    tag.tabIndex = -1; // the part list is the keyboard path
    tag.addEventListener('click', () => select(view.selected === id ? null : id));
    tag.addEventListener('mouseenter', () => setHovered(id));
    tag.addEventListener('mouseleave', () => setHovered(null));
    labels.appendChild(tag);
    view.labels[id] = tag;
  }
  $('#v3dReset').addEventListener('click', () => { select(null); flyTo(DEFAULT_CAM, DEFAULT_TARGET); });
}

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function renderUi() {
  for (const p of view.parts) {
    const row = view.rows[p.id];
    if (!row) continue;
    row.dataset.level = p.level;
    row.setAttribute('aria-pressed', String(view.selected === p.id));
    setText(row.querySelector('.v3d-name'), p.label);
    setText(row.querySelector('.v3d-level'), p.levelLabel);
    setText(row.querySelector('.v3d-sum'), p.level === 'ok' ? '' : p.summary);
    const tag = view.labels[p.id];
    if (tag) {
      tag.dataset.level = p.level;
      tag.classList.toggle('active', view.selected === p.id);
      setText(tag, p.level === 'ok' ? p.label : `${p.label}・${p.levelLabel}`);
    }
  }
  const affected = view.parts.filter((p) => p.level !== 'ok' && p.level !== 'info');
  setText($('#v3dSummary'), affected.length ? `有狀況的部位：${affected.map((p) => `${p.label}（${p.levelLabel}）`).join('、')}` : '所有部位正常');

  const detail = $('#v3dDetail');
  const p = view.parts.find((x) => x.id === view.selected);
  const html = p ? `<h3>${esc(p.label)} <span class="v3d-chip" data-level="${p.level}">${esc(p.levelLabel)}</span></h3>
    ${p.items.length ? `<ul class="v3d-items">${p.items.map((i) => `<li data-level="${i.level}">${esc(i.text)}</li>`).join('')}</ul>` : '<p class="hint">目前沒有狀況。</p>'}
    <p class="hint">設備：${p.devices.length ? p.devices.map((d) => `${esc(d.name)}（${esc(STATUS_LABEL[d.status] || d.status)}）`).join('、') : '無'}</p>`
    : view.webgl && !view.contextLost
      ? '<p class="hint">點選 3D 車輛的部位、標籤或上方清單，查看該部位的狀況與設備。</p>'
      : '<p class="hint">點選上方清單的部位，查看該部位的狀況與設備。</p>';
  if (detail.dataset.html !== html) {
    detail.innerHTML = html;
    detail.dataset.html = html;
  }
}

function setHovered(id) {
  if (view.hovered === id) return;
  view.hovered = id;
  view.dirty = true;
  if (renderer) renderer.domElement.style.cursor = id ? 'pointer' : '';
}

function flyTo(pos, target) {
  if (!camera) return;
  view.camPos.set(...pos);
  view.camTarget.set(...target);
  view.camAnimating = true;
}

function select(id) {
  view.selected = id;
  view.dirty = true;
  if (id) flyTo(PART_VIEW[id].cam, PART_VIEW[id].target);
  renderUi();
}

// ------------------------------------------------------------------ boot
function onState(s) {
  if (!s || !Array.isArray(s.vehicleParts)) return;
  // The dashboard pushes the whole state every simulated second; redraw only when a part changed.
  const key = JSON.stringify(s.vehicleParts);
  if (key === view.partsKey) return;
  view.partsKey = key;
  view.parts = s.vehicleParts;
  view.dirty = true;
  renderUi();
}

// Loads three.js; returns false when it cannot be loaded (offline without the server's copy, a
// browser without import maps, ...).
async function loadThree() {
  try {
    const [three, addons] = await Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]);
    THREE = three;
    ({ OrbitControls } = addons);
    return true;
  } catch (err) {
    console.warn('3D 預覽：three.js 載入失敗', err);
    return false;
  }
}

async function boot() {
  const viewport = $('#v3dViewport');
  if (!viewport) return;
  window.vehicle3d = { frames: () => view.frames }; // for automated checks
  buildList();
  window.addEventListener('cabin:state', (e) => onState(e.detail));
  onState(window.cabinState);

  let reason = null;
  if (!webglAvailable()) reason = 'webgl';
  else if (!(await loadThree())) reason = 'load';
  else if (!initScene(viewport)) reason = 'webgl';
  if (reason) {
    showFallback(viewport, reason);
    viewport.dataset.ready = 'fallback';
    renderUi();
    return;
  }
  view.webgl = true;
  buildLabels();
  if (view.selected) flyTo(PART_VIEW[view.selected].cam, PART_VIEW[view.selected].target); // picked in the list while loading
  hideFallback(viewport);
  view.dirty = true;
  renderUi();
  loop(viewport);
  viewport.dataset.ready = 'webgl';
}

boot();
