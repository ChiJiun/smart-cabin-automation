'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('B2: siren mutes audio and shows direction; ending restores volume', () => {
  const { act, s, dev } = setup();
  assert.equal(dev('audio').drawW, 70);
  act('siren', { active: true, direction: 'rear' });
  assert.equal(dev('audio').mode, 'MUTED');
  assert.equal(dev('audio').drawW, 10);
  assert.equal(s().mainAlert.title, '後方有救護車，請注意避讓');
  act('siren', { active: false });
  assert.equal(dev('audio').mode, 'PLAYING');
  assert.equal(dev('audio').level, 5);
  assert.equal(s().alerts.length, 0);
});

test('B2: audio stays muted after siren ends while a collision is active', () => {
  const { act, dev } = setup();
  act('siren', { active: true, direction: 'left' });
  act('impact', { g: 6 });
  act('siren', { active: false });
  assert.notEqual(dev('audio').mode, 'PLAYING');
  act('clearIncident');
  assert.equal(dev('audio').mode, 'PLAYING');
});

test('B2: the siren is detected by the audio sensor (with its bearing)', () => {
  const { act, s, dev } = setup();
  assert.equal(dev('audio-sensor').mode, 'LISTENING');
  act('siren', { active: true, direction: 'right' });
  assert.equal(dev('audio-sensor').mode, 'SIREN_DETECTED');
  assert.equal(dev('audio-sensor').status, 'WARNING');
  assert.match(s().log.find((l) => l.kind === 'event' && /笛聲/.test(l.message)).message, /音訊傳感器偵測到緊急車輛笛聲，解析方位：右側/);
  assert.equal(s().mainAlert.title, '右側有救護車，請注意避讓');
});

test('B2: a faulted audio sensor cannot hear the siren; repairing it picks the siren up', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'audio-sensor', fault: true });
  act('siren', { active: true, direction: 'rear' });
  assert.equal(dev('audio').mode, 'PLAYING');
  assert.ok(!s().alerts.some((a) => a.id === 'siren'));
  assert.ok(s().alerts.some((a) => a.title === '救護車笛聲偵測失效'));
  assert.ok(s().log.some((l) => /後方出現救護車笛聲，但音訊傳感器故障，未被偵測/.test(l.message)));
  act('setFault', { id: 'audio-sensor', fault: false });
  assert.equal(dev('audio').mode, 'MUTED');
  assert.equal(s().mainAlert.title, '後方有救護車，請注意避讓');
  act('siren', { active: false });
  assert.equal(dev('audio').mode, 'PLAYING');
  assert.equal(dev('audio').level, 5);
});

test('B2: without an audio sensor the siren is not detected', () => {
  const { e, act, s, dev } = setup();
  e.deleteDevice('audio-sensor');
  act('siren', { active: true, direction: 'front' });
  assert.equal(dev('audio').mode, 'PLAYING');
  assert.ok(s().log.some((l) => /未配置音訊傳感器，未被偵測/.test(l.message)));
});

test('B2: collision outranks siren on the main banner', () => {
  const { act, s } = setup();
  act('siren', { active: true, direction: 'rear' });
  act('impact', { g: 6 });
  assert.equal(s().mainAlert.id, 'collision');
  assert.ok(s().alerts.some((a) => a.id === 'siren'));
});
