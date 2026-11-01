'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('B5: default state is NORMAL at 203 W / 1000 W', () => {
  const { s } = setup();
  assert.equal(s().power.demandW, 203);
  assert.equal(s().power.status, 'NORMAL');
});

test('B5: 80–100 % load -> HIGH_LOAD warning, nothing shed', () => {
  const { act, s } = setup();
  act('setDevice', { id: 'inverter', on: true, load: 300 });
  act('setDevice', { id: 'fridge', on: true });
  act('setDevice', { id: 'seat-driver', on: true, level: 3 });
  act('setDevice', { id: 'seat-passenger', on: true, level: 2 });
  // 203 + 300 + 60 + 135 + 90 = 788 -> 78.8 %
  assert.equal(s().power.status, 'NORMAL');
  act('setDevice', { id: 'screen-rear-left', on: true }); // 818 -> 81.8 %
  assert.equal(s().power.status, 'HIGH_LOAD');
  assert.ok(s().alerts.some((a) => a.id === 'power' && /用電量偏高/.test(a.title)));
  assert.ok(s().devices.every((d) => d.powerState === 'NORMAL'));
});

test('B5: winter overload scenario sheds P3 in order and keeps demand <= capacity', () => {
  const { e, s, dev } = setup();
  e.loadScenario('winter-overload');
  assert.equal(s().power.requestedW, 1288);
  assert.equal(s().power.demandW, 958);
  assert.equal(s().power.status, 'OVERLOAD');
  for (const id of ['inverter', 'screen-rear-left', 'screen-rear-right']) assert.equal(dev(id).powerState, 'DEFERRED');
  assert.equal(dev('audio').powerState, 'SHED'); // was running before -> shed, not deferred
  assert.equal(dev('seat-rear').powerState, 'NORMAL');
  assert.equal(dev('hvac').effectiveLevel, 5);
});

test('B5: alternator fault (400 W) -> seat heaters stepped down to 0, HVAC reduced to level 2', () => {
  const { e, s, dev } = setup();
  e.loadScenario('alternator-fault');
  assert.equal(s().power.capacityW, 400);
  assert.ok(s().power.demandW <= 400);
  for (const id of ['seat-rear', 'seat-passenger', 'seat-driver']) assert.equal(dev(id).powerState, 'SHED');
  assert.equal(dev('hvac').powerState, 'REDUCED');
  assert.equal(dev('hvac').effectiveLevel, 2);
  assert.equal(dev('defroster').powerState, 'NORMAL'); // P1 simple device never shed
  assert.ok(s().alerts.some((a) => a.id === 'alternator'));
});

test('B5: restoring capacity restores devices in reverse order', () => {
  const { e, act, s, dev } = setup();
  e.loadScenario('alternator-fault');
  act('setAlternatorFault', { fault: false });
  assert.equal(dev('hvac').effectiveLevel, 5);
  assert.equal(dev('seat-driver').powerState, 'NORMAL');
  assert.equal(s().power.demandW, 958);
  act('setCapacity', { watts: 1300 });
  assert.ok(s().devices.every((d) => d.powerState === 'NORMAL'));
  assert.equal(s().power.demandW, 1288);
});

test('B5: P1/P2 seat heaters are reduced one level at a time (rear first)', () => {
  const { act, dev } = setup();
  act('setDevice', { id: 'seat-rear', on: true, level: 3 });
  act('setDevice', { id: 'seat-driver', on: true, level: 3 });
  act('setDevice', { id: 'audio', on: false });
  // 133 + 135 + 135 = 403
  act('setCapacity', { watts: 330 });
  // need -73: rear 3->2 (-45) -> 358, rear 2->1 (-45) -> 313
  assert.equal(dev('seat-rear').powerState, 'REDUCED');
  assert.equal(dev('seat-rear').effectiveLevel, 1);
  assert.equal(dev('seat-driver').effectiveLevel, 3);
});

test('B5: CRITICAL_POWER when P0 + P1 minimum exceeds capacity', () => {
  const { e, s } = setup();
  e.loadScenario('critical-power');
  assert.equal(s().power.status, 'CRITICAL_POWER');
  assert.equal(s().power.demandW, 313);
  assert.ok(s().alerts.some((a) => a.title === '電力不足，僅維持安全設備'));
});

test('B5: a device turned on without headroom is DEFERRED and starts automatically later', () => {
  const { act, s, dev } = setup();
  act('setCapacity', { watts: 250 });
  act('setDevice', { id: 'fridge', on: true }); // 263 > 250 -> fridge (first in order) deferred
  assert.equal(dev('fridge').powerState, 'DEFERRED');
  assert.match(s().alerts.find((a) => a.id === 'power').message, /延後啟動：車用冰箱/);
  act('setCapacity', { watts: 300 });
  assert.equal(dev('fridge').powerState, 'NORMAL');
  assert.equal(dev('fridge').drawW, 60);
});
