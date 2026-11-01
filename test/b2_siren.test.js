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

test('B2: collision outranks siren on the main banner', () => {
  const { act, s } = setup();
  act('siren', { active: true, direction: 'rear' });
  act('impact', { g: 6 });
  assert.equal(s().mainAlert.id, 'collision');
  assert.ok(s().alerts.some((a) => a.id === 'siren'));
});
