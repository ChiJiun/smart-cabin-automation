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
  act('factoryReset');
  assert.ok(!s().devices.some((d) => d.id === 'fridge-2'));
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
