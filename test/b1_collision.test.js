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

test('B1: eCall counts down 10 s, then CONNECTED (119 + 110 by default); upload completes in 10 s', () => {
  const { e, act, s, dev } = setup();
  act('impact', { g: 6 });
  e.tick(5);
  assert.equal(s().incident.ecallRemainingS, 5);
  assert.equal(s().incident.uploadProgress, 50);
  e.tick(5);
  assert.equal(dev('ecall').mode, 'CONNECTED');
  assert.equal(s().incident.ecallService, 'both');
  assert.equal(dev('dashcam-front').mode, 'UPLOADED');
  assert.match(s().mainAlert.message, /已連線 119（救護）並通報 110（警政）.*撞擊方向（前方）/);
  assert.ok(s().log.some((l) => /已傳送 GPS 座標（25.0330, 121.5654）與撞擊方向（前方）/.test(l.message)));
});

test('B1: with a dialling delay the eCall passes through CALLING before CONNECTED', () => {
  const { e, act, dev } = setup();
  e.updateSettings({ ecallConnectS: 2 });
  act('impact', { g: 6 });
  e.tick(10);
  assert.equal(dev('ecall').mode, 'CALLING');
  e.tick(1);
  assert.equal(dev('ecall').mode, 'CALLING');
  e.tick(1);
  assert.equal(dev('ecall').mode, 'CONNECTED');
});

test('B1: the driver can choose 119 or 110 during the countdown; the call starts at once', () => {
  const { e, act, s, dev } = setup();
  act('impact', { g: 6 });
  e.tick(3);
  assert.match(s().mainAlert.message, /7 秒後.*選擇撥打 119（救護）或 110（警政）/);
  act('selectEcall', { service: '110' });
  assert.equal(dev('ecall').mode, 'CONNECTED');
  assert.equal(s().incident.ecallService, '110');
  assert.match(s().mainAlert.message, /已連線 110（警政）/);
  assert.doesNotMatch(s().mainAlert.message, /119/);
  assert.throws(() => act('selectEcall', { service: '119' }), /倒數期間/);
  assert.throws(() => act('cancelEcall'), /倒數/);
  const other = setup();
  other.act('impact', { g: 6 });
  assert.throws(() => other.act('selectEcall', { service: '112' }), /119 或 110/);
  other.act('selectEcall', { service: 119 });
  assert.equal(other.s().incident.ecallService, '119');
  assert.match(other.s().mainAlert.message, /已連線 119（救護）/);
});

test('B1: rear impact is marked as rear; the rear dashcam uploads first', () => {
  const { act, s, dev } = setup();
  act('setDevice', { id: 'seat-driver', on: true, level: 2 });
  act('impact', { g: 5.5, direction: 'rear' });
  assert.equal(s().incident.direction, 'rear');
  assert.equal(s().mainAlert.title, '後方撞擊事故（5.5 g）');
  assert.equal(s().incident.uploadSource, 'dashcam-rear');
  assert.equal(dev('dashcam-rear').mode, 'UPLOADING');
  assert.equal(dev('dashcam-front').mode, 'EMERGENCY_LOCK');
  assert.equal(dev('g-sensor-rear').mode, 'IMPACT_DETECTED');
  assert.equal(dev('g-sensor').mode, 'MONITORING');
  assert.equal(dev('seat-driver').powerState, 'SHED'); // P2 shed by the emergency reserve
  assert.ok(s().log.some((l) => /受撞擊側（後方）記錄器「後行車記錄器」優先上傳/.test(l.message)));
  assert.throws(() => setup().act('impact', { g: 6, direction: 'side' }), /front 或 rear/);
});

test('B1: rear dashcam fault -> front dashcam uploads after a rear impact; faulted sensor does not detect', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'dashcam-rear', fault: true });
  act('impact', { g: 6, direction: 'rear' });
  assert.equal(s().incident.uploadSource, 'dashcam-front');
  assert.equal(dev('dashcam-front').mode, 'UPLOADING');
  assert.ok(s().log.some((l) => /後方記錄器無法使用，改由「前行車記錄器」上傳影像/.test(l.message)));
  const other = setup();
  other.act('setFault', { id: 'g-sensor-rear', fault: true });
  other.act('impact', { g: 6, direction: 'rear' });
  assert.equal(other.s().incident.active, false);
  assert.match(other.s().log.at(-1).message, /後方碰撞傳感器故障/);
  other.act('impact', { g: 6, direction: 'front' }); // the front sensor still works
  assert.equal(other.s().incident.active, true);
});

test('B1: the audio is forced off during an incident even when configured as P1', () => {
  const { e, act, dev } = setup();
  e.updateDevice('audio', { priority: 1 });
  act('impact', { g: 6 });
  assert.equal(dev('audio').powerState, 'SHED');
  assert.equal(dev('audio').powerReason, 'EMERGENCY_RESERVE');
  assert.equal(dev('audio').drawW, 0);
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
