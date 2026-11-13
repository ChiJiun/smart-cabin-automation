'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');
const { createApp } = require('../server');
const { Engine } = require('../src/engine/Engine');
const { partOfDevice } = require('../src/engine/vehicleParts');

const parts = (s) => Object.fromEntries(s().vehicleParts.map((p) => [p.id, p]));
const levels = (s) => Object.fromEntries(s().vehicleParts.map((p) => [p.id, p.level]));

test('3D: every part is normal in the default state and every device belongs to one part', () => {
  const { e, s } = setup();
  assert.deepEqual(levels(s), { front: 'ok', rear: 'ok', mirror_left: 'ok', mirror_right: 'ok', cabin: 'ok', chassis: 'ok' });
  assert.equal(parts(s).front.summary, '正常');
  const all = s().vehicleParts.flatMap((p) => p.devices.map((d) => d.id)).sort();
  assert.deepEqual(all, s().devices.map((d) => d.id).sort(), 'each device is listed exactly once');
  assert.deepEqual(e.publicState().vehicleParts, s().vehicleParts, 'published with the state');
  assert.equal(partOfDevice({ type: 'mirror', props: { side: 'right' } }), 'mirror_right');
  assert.equal(partOfDevice({ type: 'dashcam', props: { position: 'rear' } }), 'rear');
  assert.equal(partOfDevice({ type: 'defroster', props: {} }), 'rear');
  assert.equal(partOfDevice({ type: 'ecu', props: {} }), 'chassis');
  assert.equal(partOfDevice({ type: 'hvac', props: {} }), 'cabin');
});

test('3D: a collision highlights the struck end and the eCall call in the cabin', () => {
  const { e, act, s } = setup();
  act('impact', { g: 6, direction: 'rear' });
  let p = parts(s);
  assert.equal(p.rear.level, 'critical');
  assert.equal(p.rear.summary, '後方撞擊 6 g');
  assert.equal(p.cabin.level, 'critical');
  assert.equal(p.cabin.summary, 'eCall 倒數 10 秒');
  assert.equal(p.front.level, 'info', 'the other dashcam is locked');
  assert.equal(p.front.summary, '前行車記錄器 鎖定保存');
  assert.ok(p.rear.items.some((i) => i.text === '後行車記錄器 上傳影像中'));
  e.tick(10);
  p = parts(s);
  assert.equal(p.cabin.level, 'info');
  assert.equal(p.cabin.summary, 'eCall 已連線');
  act('clearIncident');
  assert.equal(parts(s).rear.level, 'ok');
  act('impact', { g: 6, direction: 'front' });
  assert.equal(parts(s).front.level, 'critical');
  assert.equal(parts(s).front.summary, '前方撞擊 6 g');
});

test('3D: an interrupted eCall is critical until the driver acknowledges it', () => {
  const { act, s } = setup();
  act('impact', { g: 6 });
  act('setFault', { id: 'ecall', fault: true });
  let p = parts(s);
  assert.equal(p.cabin.level, 'critical');
  assert.equal(p.cabin.summary, 'eCall 通報中斷，請手動撥打 119 或 110');
  assert.ok(p.cabin.items.some((i) => i.level === 'fault' && i.text === '緊急通報模組 (eCall) 故障'));
  act('ackEcallFault');
  p = parts(s);
  assert.equal(p.cabin.level, 'fault', 'the faulted module is still shown');
  assert.ok(p.cabin.items.some((i) => i.level === 'warning' && /已確認/.test(i.text)));
});

test('3D: the blind spot lights the mirror on that side (critical only with a lane-change conflict)', () => {
  const { act, s } = setup();
  act('blindSpot', { side: 'left', detected: true });
  assert.equal(parts(s).mirror_left.level, 'warning');
  assert.equal(parts(s).mirror_left.summary, '盲區有車');
  act('turnSignal', { value: 'left' });
  assert.equal(parts(s).mirror_left.level, 'critical');
  assert.equal(parts(s).mirror_left.summary, '盲區有來車，請勿變換車道');
  assert.equal(parts(s).mirror_right.level, 'ok');
  act('turnSignal', { value: 'off' });
  assert.equal(parts(s).mirror_left.level, 'warning');
  act('setFault', { id: 'radar-left', fault: true });
  assert.equal(parts(s).mirror_left.level, 'fault', 'a faulted radar cannot detect, the fault is shown');
  assert.equal(parts(s).mirror_left.summary, '左盲區雷達 故障');
});

test('3D: the siren is shown on the part it comes from, only once the audio sensor hears it', () => {
  for (const [dir, part] of [['rear', 'rear'], ['front', 'front'], ['left', 'mirror_left'], ['right', 'mirror_right']]) {
    const { act, s } = setup();
    act('siren', { active: true, direction: dir });
    assert.equal(parts(s)[part].level, 'warning', dir);
    assert.match(parts(s)[part].summary, /有救護車$/);
    assert.ok(parts(s).cabin.items.some((i) => i.text === '娛樂音響 靜音'));
  }
  const { act, s } = setup();
  act('setFault', { id: 'audio-sensor', fault: true });
  act('siren', { active: true, direction: 'rear' });
  assert.equal(parts(s).rear.level, 'ok', 'not detected');
  assert.equal(parts(s).cabin.level, 'fault');
});

test('3D: low range and power problems are shown on the chassis and the cabin', () => {
  const { e, act, s } = setup();
  act('setRange', { km: 25 });
  assert.equal(parts(s).chassis.level, 'warning');
  assert.equal(parts(s).chassis.summary, '剩餘里程過低（25 km）');
  act('setRange', { km: 8 });
  assert.equal(parts(s).chassis.level, 'critical');
  act('setFault', { id: 'ecu', fault: true });
  assert.equal(parts(s).chassis.level, 'fault');
  assert.ok(parts(s).chassis.items.some((i) => i.text === '里程資訊無法取得'));

  e.loadScenario('winter-overload');
  assert.equal(parts(s).cabin.level, 'warning');
  assert.equal(parts(s).cabin.summary, '電力超載（需求 129.6%）');
  assert.ok(parts(s).rear.items.some((i) => i.text === '後擋風除霧 運作中'));
  e.loadScenario('critical-power');
  assert.equal(parts(s).cabin.level, 'critical');
  act('setAlternatorFault', { fault: true });
  assert.ok(parts(s).chassis.items.some((i) => i.text === '發電機異常，電瓶供電中'));
});

test('3D: a removed safety device is shown on the part where it would be mounted', () => {
  const cases = [
    ['g-sensor', 'front'], ['g-sensor-rear', 'rear'], ['radar-left', 'mirror_left'], ['mirror-right', 'mirror_right'],
    ['ecall', 'cabin'], ['buzzer', 'cabin'],
  ];
  for (const [id, part] of cases) {
    const { e, s } = setup();
    e.deleteDevice(id);
    assert.equal(parts(s)[part].level, 'warning', id);
    assert.match(parts(s)[part].summary, /未配置/);
  }
  const { e, s } = setup();
  e.deleteDevice('dashcam-front');
  e.deleteDevice('dashcam-rear');
  assert.equal(parts(s).front.level, 'warning');
  assert.equal(parts(s).rear.level, 'warning');
});

test('3D: items are ordered by severity and the part takes the most severe level', () => {
  const { act, s } = setup();
  act('setFault', { id: 'dashcam-rear', fault: true });
  act('siren', { active: true, direction: 'rear' });
  act('impact', { g: 6, direction: 'rear' });
  const rear = parts(s).rear;
  assert.deepEqual(rear.items.map((i) => i.level), ['critical', 'fault', 'warning']);
  assert.equal(rear.level, 'critical');
  assert.equal(rear.levelLabel, '危急');
});

test('HTTP: three.js is served locally for the 3D preview', async () => {
  const engine = new Engine();
  engine.state.clockRunning = false;
  const server = http.createServer(createApp(engine)).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/vendor/three/build/three.module.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    r = await fetch(`${base}/vendor/three/addons/controls/OrbitControls.js`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /from 'three'/);
    r = await fetch(`${base}/vehicle3d.js`);
    assert.equal(r.status, 200);
    r = await fetch(`${base}/`);
    const html = await r.text();
    assert.match(html, /<script type="importmap">/);
    assert.match(html, /id="v3dViewport"/);
    assert.match(html, /<script type="module" src="vehicle3d.js"><\/script>/);
  } finally {
    server.close();
  }
});
