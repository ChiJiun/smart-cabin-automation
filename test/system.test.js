'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');
const { createApp } = require('../server');
const { Engine } = require('../src/engine/Engine');

test('reset restores the known initial state but keeps configuration', () => {
  const { e, act, s } = setup();
  act('setCapacity', { watts: 500 });
  e.addDevice({ id: 'fridge-2', type: 'fridge', name: '冰箱 2', zone: 'rear_cabin' });
  act('impact', { g: 9 });
  act('setRange', { km: 5 });
  act('reset');
  assert.equal(s().simTime, 0);
  assert.equal(s().incident.active, false);
  assert.equal(s().settings.capacityW, 1000);
  assert.equal(s().environment.rangeKm, 120);
  assert.ok(s().devices.some((d) => d.id === 'fridge-2'));
  e.updateSettings({ capacityW: 500, ecallConnectS: 7 });
  e.updateDevice('audio', { priority: 1 });
  act('factoryReset');
  assert.ok(!s().devices.some((d) => d.id === 'fridge-2'));
  // configuration is reloaded from the built-in JSON data file
  const json = require('../src/config/defaultVehicle.json');
  assert.deepEqual(s().settings, json.settings);
  assert.equal(s().devices.find((d) => d.id === 'audio').priority, 3);
  assert.equal(s().devices.length, json.devices.length);
  assert.equal(s().power.demandW, 211);
});

test('config: device priority affects shedding; safety devices locked to P0', () => {
  const { e, act, dev } = setup();
  assert.throws(() => e.updateDevice('ecall', { priority: 3 }), /P0/);
  assert.throws(() => e.updateDevice('fridge', { priority: 0 }), /P1–P3/);
  e.updateDevice('audio', { priority: 1 }); // audio becomes P1 adjustable: reduced but kept on
  act('setCapacity', { watts: 150 });
  assert.equal(dev('audio').powerState, 'REDUCED');
  assert.equal(dev('audio').effectiveLevel, 1); // P1 keeps at least level 1
  assert.equal(dev('audio').drawW, 22);
});

test('config: zones cannot be deleted while devices remain; device CRUD validates input', () => {
  const { e } = setup();
  assert.throws(() => e.deleteZone('front'), /仍有設備/);
  e.addZone({ id: 'trunk', name: '後車廂' });
  e.addDevice({ id: 'fridge-2', type: 'fridge', name: '冰箱 2', zone: 'trunk', priority: 3, shedOrder: 0, ratedW: 80 });
  assert.equal(e.state.devices.find((d) => d.id === 'fridge-2').ratedW, 80);
  assert.throws(() => e.addDevice({ id: 'fridge-2', type: 'fridge', name: 'x', zone: 'trunk' }), /已存在/);
  assert.throws(() => e.addDevice({ id: 'm3', type: 'mirror', name: 'x', zone: 'trunk' }), /side/);
  e.deleteDevice('fridge-2');
  e.deleteZone('trunk');
  assert.ok(!e.config.zones.some((z) => z.id === 'trunk'));
});

test('invalid actions are rejected with a message', () => {
  const { act } = setup();
  assert.throws(() => act('nope'), /未知的操作/);
  assert.throws(() => act('setAmbient', { celsius: 99 }), /介於/);
  assert.throws(() => act('setDevice', { id: 'ecall', on: false }), /無法手動操作/);
});

test('HTTP API: actions, validation errors and config endpoints', async () => {
  const engine = new Engine();
  engine.state.clockRunning = false;
  const server = http.createServer(createApp(engine)).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'impact', g: 5 }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).incident.active, true);
    r = await fetch(`${base}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'setRange', km: 'abc' }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/config`);
    assert.equal((await r.json()).zones.length, 5);
    r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
  } finally {
    server.close();
  }
});

test('device status is always one of the seven proposal statuses', () => {
  const { e, act, s } = setup();
  const { STATUSES } = require('../src/engine/rules');
  const check = () => { for (const d of s().devices) assert.ok(STATUSES.includes(d.status), `${d.id}: ${d.status}`); };
  check();
  assert.equal(s().devices.find((d) => d.id === 'seat-driver').status, 'STANDBY'); // switched off = standby
  e.loadScenario('alternator-fault');
  check();
  act('impact', { g: 6, direction: 'rear' });
  act('setFault', { id: 'ecu', fault: true });
  check();
  assert.ok(s().devices.every((d) => d.status !== 'OFF'));
});

test('system level: NORMAL / WARNING / CRITICAL follow the alerts; a P0 fault is a WARNING', () => {
  const { act, s } = setup();
  assert.equal(s().systemLevel, 'NORMAL');
  act('siren', { active: true, direction: 'rear' });
  assert.equal(s().systemLevel, 'WARNING');
  act('blindSpot', { side: 'left', detected: true });
  act('turnSignal', { value: 'left' });
  assert.equal(s().systemLevel, 'CRITICAL');
  act('reset');
  act('setFault', { id: 'fridge', fault: true }); // P3 fault: informational only
  assert.equal(s().systemLevel, 'NORMAL');
  act('setFault', { id: 'ecall', fault: true }); // safety device fault
  assert.equal(s().systemLevel, 'WARNING');
  act('reset');
  act('setRange', { km: 8 });
  assert.equal(s().systemLevel, 'CRITICAL'); // red CRITICAL_RANGE
});

test('zone status is the most severe status of its devices', () => {
  const { e, act, s } = setup();
  const { deriveZoneStatus } = require('../src/engine/rules');
  assert.equal(deriveZoneStatus([]), 'STANDBY');
  assert.equal(deriveZoneStatus([{ status: 'STANDBY' }, { status: 'NORMAL' }]), 'NORMAL');
  assert.equal(deriveZoneStatus([{ status: 'SHED' }, { status: 'DEFERRED' }]), 'SHED');
  assert.equal(deriveZoneStatus([{ status: 'FAULT' }, { status: 'WARNING' }]), 'FAULT');
  assert.equal(deriveZoneStatus([{ status: 'FAULT' }, { status: 'EMERGENCY' }]), 'EMERGENCY');
  assert.equal(s().zoneStatus.rear_cabin, 'STANDBY'); // everything switched off
  e.loadScenario('winter-overload');
  assert.equal(s().zoneStatus.rear_cabin, 'DEFERRED');
  act('setFault', { id: 'ecu', fault: true });
  assert.equal(s().zoneStatus.powertrain, 'FAULT');
  const zones = e.publicState().zones;
  assert.equal(zones.find((z) => z.id === 'powertrain').status, 'FAULT');
  assert.equal(zones.find((z) => z.id === 'rear_cabin').drawW, s().devices.filter((d) => d.zone === 'rear_cabin').reduce((a, d) => a + d.drawW, 0));
  e.addZone({ id: 'trunk', name: '後車廂' });
  assert.equal(e.publicState().zones.find((z) => z.id === 'trunk').status, 'STANDBY');
});

test('reproducibility: the same actions from a reset give the same state and log', () => {
  const run = () => {
    const { e, act } = setup();
    e.loadScenario('winter-overload');
    act('impact', { g: 7, direction: 'rear' });
    act('clock', { command: 'step', seconds: 4 });
    act('selectEcall', { service: '110' });
    act('clock', { command: 'step', seconds: 10 });
    act('siren', { active: true, direction: 'left' });
    act('clearIncident');
    act('setRange', { km: 9 });
    const st = e.publicState();
    return JSON.stringify({ log: e.exportLog(), devices: st.devices, power: st.power, alerts: st.alerts, systemLevel: st.systemLevel });
  };
  assert.equal(run(), run());
});

test('HTTP API: the full log can be exported as JSON and CSV', async () => {
  const engine = new Engine();
  engine.state.clockRunning = false;
  engine.addDevice({ id: 'csv-test', type: 'fridge', name: '=HYPERLINK("x")', zone: 'rear_cabin' });
  engine.dispatch({ type: 'setDevice', id: 'csv-test', on: true }); // logs a line that starts with the name
  engine.dispatch({ type: 'impact', g: 6, direction: 'front' });
  const server = http.createServer(createApp(engine)).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/api/log?format=json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /smart-cabin-log\.json/);
    const body = await r.json();
    assert.equal(body.entries.length, engine.state.log.length);
    assert.ok(body.entries.every((l, i) => l.seq === i + 1 && /^T\+\d\d:\d\d$/.test(l.time)));
    r = await fetch(`${base}/api/log?format=csv`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const csv = await r.text();
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.equal(lines[0], 'seq,t,time,kind,message');
    assert.equal(lines.length, engine.state.log.length + 1);
    assert.ok(lines.some((l) => l.includes('"\'=HYPERLINK(""x"")：OFF → ON"')), 'a cell that starts with = is neutralised');
    assert.ok(!lines.some((l) => /(^|,)"[=+\-@]/.test(l)));
  } finally {
    server.close();
  }
});

test('every incident gets a new id, also when a scenario reset the clock in between', () => {
  const { e, s } = setup();
  e.dispatch({ type: 'scenario', name: 'collision-rear' });
  const first = s().incident;
  assert.equal(first.active, true);
  e.dispatch({ type: 'reset' });
  e.dispatch({ type: 'impact', g: 6, direction: 'front' });
  const second = s().incident;
  assert.equal(second.startedAt, first.startedAt); // the clock was reset: startedAt alone is ambiguous
  assert.notEqual(second.id, first.id);
});

test('a rejected setDevice request changes nothing; booleans and integers are checked strictly', () => {
  const { act, dev } = setup();
  const before = { ...dev('seat-driver') };
  assert.throws(() => act('setDevice', { id: 'seat-driver', on: true, level: 99 }), /檔位/);
  assert.equal(dev('seat-driver').on, before.on);
  assert.equal(dev('seat-driver').level, before.level);
  assert.throws(() => act('setDevice', { id: 'seat-driver', on: 'false' }), /true 或 false/);
  assert.throws(() => act('setDevice', { id: 'seat-driver', level: 1.5 }), /整數/);
  assert.throws(() => act('setDevice', { id: 'seat-driver' }), /沒有要變更/);
  assert.throws(() => act('setFault', { id: 'seat-driver', fault: 1 }), /true 或 false/);
  assert.throws(() => act('setRange', { km: '' }), /必須是數字/);
  assert.throws(() => act('setRange', { km: true }), /必須是數字/);
});

test('names inherited from Object.prototype are not accepted as actions, scenarios, settings, types or ids', () => {
  const { e, act } = setup();
  assert.throws(() => act('constructor'), /未知的操作/);
  assert.throws(() => act('scenario', { name: 'toString' }), /未知的情境/);
  assert.throws(() => act('siren', { active: true, direction: 'constructor' }), /方位/);
  assert.throws(() => e.updateSettings({ constructor: 1 }), /未知的設定/);
  assert.throws(() => e.addDevice({ id: 'x1', type: 'constructor', name: 'x', zone: 'front' }), /設備類型無效/);
  assert.throws(() => e.addDevice({ id: '__proto__', type: 'fridge', name: 'x', zone: 'rear_cabin' }), /保留字/);
  assert.throws(() => e.addZone({ id: 'constructor', name: 'x' }), /保留字/);
});

test('settings: only changed values reach the running state; thresholds are re-applied and cross-checked', () => {
  const { e, act, s } = setup();
  act('setCapacity', { watts: 400 });
  e.updateSettings({ ...e.getConfig().settings, ecallCountdownS: 15 }); // the configuration page sends every field
  assert.equal(s().settings.capacityW, 400);
  assert.equal(s().settings.ecallCountdownS, 15);
  assert.match(s().log.at(-1).message, /eCall 倒數秒數 15/);
  act('setRange', { km: 40 });
  assert.equal(s().lowRange.active, false);
  e.updateSettings({ lowRangeKm: 50, lowRangeClearKm: 55 });
  assert.equal(s().lowRange.active, true);
  assert.ok(s().alerts.some((a) => a.id === 'low-range'));
  assert.throws(() => e.updateSettings({ criticalRangeKm: 60 }), /極低里程門檻/);
  assert.throws(() => e.updateSettings({ reachableFactor: 1.5 }), /可抵達係數/);
  e.updateSettings({ defrostOnC: -5, defrostOffC: -2 }); // temperatures may be negative
  assert.equal(s().settings.defrostOnC, -5);
});

test('HTTP API: malformed JSON is answered with a JSON error', async () => {
  const engine = new Engine();
  engine.state.clockRunning = false;
  const server = http.createServer(createApp(engine)).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(r.status, 400);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.match((await r.json()).error, /JSON/);
  } finally {
    server.close();
  }
});

test('a removed safety device is reported like a faulted one and raises the system level to WARNING', () => {
  const cases = [
    ['g-sensor', 'missing-g_sensor-front', '前方撞擊偵測失效'],
    ['g-sensor-rear', 'missing-g_sensor-rear', '後方撞擊偵測失效'],
    ['ecall', 'missing-ecall', '緊急通報無法使用'],
    ['audio-sensor', 'missing-audio_sensor', '救護車笛聲偵測失效'],
    ['radar-left', 'missing-bsd_radar-left', '左側盲區輔助失效'],
    ['radar-right', 'missing-bsd_radar-right', '右側盲區輔助失效'],
    ['mirror-left', 'missing-mirror-left', '左側後視鏡 LED 無法警示'],
    ['mirror-right', 'missing-mirror-right', '右側後視鏡 LED 無法警示'],
    ['turn-signal', 'missing-turn_signal', '方向燈訊號無法取得'],
    ['buzzer', 'missing-buzzer', '警示音無法發出'],
    ['display', 'missing-display', '中控儀表未配置'],
  ];
  for (const [id, alertId, title] of cases) {
    const { e, s } = setup();
    assert.equal(s().systemLevel, 'NORMAL');
    assert.ok(!s().alerts.some((a) => a.id.startsWith('missing-')), 'the factory configuration is complete');
    const cfg = e.config.devices.find((d) => d.id === id);
    e.deleteDevice(id);
    const a = s().alerts.find((x) => x.id === alertId);
    assert.ok(a, `${id} removed -> ${alertId}`);
    assert.equal(a.title, title);
    assert.equal(a.level, 'warning');
    assert.match(a.message, /未配置/);
    assert.equal(s().systemLevel, 'WARNING', id);
    assert.equal(s().alerts.filter((x) => x.id.startsWith('missing-')).length, 1, `only ${alertId}`);
    assert.ok(s().log.some((l) => l.message === `警示：${title}`));
    // adding a device of that role back clears the alert
    e.addDevice({ ...cfg, priority: undefined });
    assert.ok(!s().alerts.some((x) => x.id === alertId), `${id} re-added`);
    assert.equal(s().systemLevel, 'NORMAL');
    assert.ok(s().log.some((l) => l.message === `警示解除：${title}`));
  }
});

test('a collision sensor without a position covers both sides; the dashcam alert needs every dashcam gone', () => {
  const { e, s } = setup();
  e.deleteDevice('g-sensor');
  e.deleteDevice('g-sensor-rear');
  assert.ok(s().alerts.some((a) => a.id === 'missing-g_sensor-front'));
  assert.ok(s().alerts.some((a) => a.id === 'missing-g_sensor-rear'));
  e.addDevice({ id: 'g-any', type: 'g_sensor', name: '全向碰撞傳感器', zone: 'front', props: { position: 'front' } });
  assert.ok(!s().alerts.some((a) => a.id === 'missing-g_sensor-front'));
  assert.ok(s().alerts.some((a) => a.id === 'missing-g_sensor-rear'));
  e.deleteDevice('dashcam-front');
  assert.ok(!s().alerts.some((a) => a.id === 'missing-dashcam'), 'the rear dashcam still records');
  e.deleteDevice('dashcam-rear');
  assert.ok(s().alerts.some((a) => a.id === 'missing-dashcam'));
});

test('every state carries a server-run id and a revision that grows with each evaluation', () => {
  const { e, act } = setup();
  const a = e.publicState();
  act('setRange', { km: 80 });
  const b = e.publicState();
  e.tick(1);
  const c = e.publicState();
  assert.equal(typeof a.bootId, 'string');
  assert.equal(a.bootId, c.bootId);
  assert.ok(b.rev > a.rev && c.rev > b.rev);
  assert.notEqual(new Engine().publicState().bootId, a.bootId, 'a restarted server has another id');
});

test('HTTP API: an unknown log export format is rejected', async () => {
  const engine = new Engine();
  engine.state.clockRunning = false;
  const server = http.createServer(createApp(engine)).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/api/log?format=xml`);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'format 必須是 json 或 csv' });
    r = await fetch(`${base}/api/log`);
    assert.equal(r.status, 200, 'JSON is the default');
    assert.ok(Array.isArray((await r.json()).entries));
  } finally {
    server.close();
  }
});

test('npm test runs every test file (the script lists them, as Node 20 on Windows does not expand globs)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const script = require('../package.json').scripts.test;
  const files = fs.readdirSync(path.join(__dirname)).filter((f) => f.endsWith('.test.js'));
  for (const f of files) assert.ok(script.split(' ').includes(`test/${f}`), `${f} is missing from the npm test script`);
  assert.ok(!/[*?]/.test(script), 'no glob in the script');
});
