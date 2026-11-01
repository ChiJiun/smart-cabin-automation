'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('B1: impact below 4.0 g only logs a minor bump', () => {
  const { act, s } = setup();
  act('impact', { g: 3.9 });
  assert.equal(s().incident.active, false);
  assert.match(s().log.at(-1).message, /輕微碰撞/);
});

test('B1: impact >= 4.0 g starts the incident chain', () => {
  const { act, s, dev } = setup();
  act('setDevice', { id: 'screen-rear-left', on: true });
  act('impact', { g: 4.0 });
  assert.equal(s().incident.active, true);
  assert.equal(s().mainAlert.id, 'collision');
  assert.equal(dev('dashcam-front').mode, 'UPLOADING');
  assert.equal(dev('dashcam-rear').mode, 'EMERGENCY_LOCK');
  assert.equal(dev('ecall').mode, 'COUNTDOWN');
  assert.equal(s().incident.ecallRemainingS, 10);
  // emergency power reserve: every P2/P3 device that was on is shed
  for (const id of ['audio', 'screen-rear-left']) {
    assert.equal(dev(id).powerState, 'SHED');
    assert.equal(dev(id).powerReason, 'EMERGENCY_RESERVE');
  }
  assert.equal(dev('hvac').powerState, 'NORMAL'); // P1 kept
  assert.equal(s().buzzer, true);
});

test('B1: eCall counts down 10 s, then CALLING, then CONNECTED; upload completes in 10 s', () => {
  const { e, act, s, dev } = setup();
  act('impact', { g: 6 });
  e.tick(5);
  assert.equal(s().incident.ecallRemainingS, 5);
  assert.equal(s().incident.uploadProgress, 50);
  e.tick(5);
  assert.equal(dev('ecall').mode, 'CALLING');
  assert.equal(dev('dashcam-front').mode, 'UPLOADED');
  e.tick(2);
  assert.equal(dev('ecall').mode, 'CONNECTED');
  assert.match(s().mainAlert.message, /119/);
});

test('B1: driver can cancel eCall during the countdown only', () => {
  const { e, act, dev } = setup();
  act('impact', { g: 6 });
  e.tick(3);
  act('cancelEcall');
  assert.equal(dev('ecall').mode, 'CANCELLED');
  e.tick(20);
  assert.equal(dev('ecall').mode, 'CANCELLED');
  assert.throws(() => act('cancelEcall'), /倒數/);
});

test('B1: clearing the incident restores previous settings', () => {
  const { act, s, dev } = setup();
  act('impact', { g: 6 });
  act('clearIncident');
  assert.equal(s().incident.active, false);
  assert.equal(dev('audio').mode, 'PLAYING');
  assert.equal(dev('audio').powerState, 'NORMAL');
  assert.equal(dev('dashcam-front').mode, 'RECORDING');
});

test('B1: front dashcam fault -> rear dashcam uploads; eCall fault -> manual 119/110', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'dashcam-front', fault: true });
  act('setFault', { id: 'ecall', fault: true });
  act('impact', { g: 6 });
  assert.equal(s().incident.uploadSource, 'dashcam-rear');
  assert.equal(dev('dashcam-rear').mode, 'UPLOADING');
  assert.equal(s().incident.ecallState, 'FAULT');
  assert.match(s().mainAlert.message, /手動撥打 119.*110/);
});
