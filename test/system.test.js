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
