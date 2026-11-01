'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('B3: same-side detection + turn signal -> flashing + buzzer', () => {
  const { act, s, dev } = setup();
  act('blindSpot', { side: 'left', detected: true });
  assert.equal(dev('mirror-left').mode, 'STEADY');
  assert.equal(s().buzzer, false);
  act('turnSignal', { value: 'left' });
  assert.equal(dev('mirror-left').mode, 'FLASHING');
  assert.equal(s().mainAlert.id, 'blindspot-left');
  assert.equal(s().buzzer, true);
});

test('B3: opposite turn signal does not trigger', () => {
  const { act, s, dev } = setup();
  act('blindSpot', { side: 'left', detected: true });
  act('turnSignal', { value: 'right' });
  assert.equal(dev('mirror-left').mode, 'STEADY');
  assert.equal(s().buzzer, false);
});

test('B3: warning clears immediately when signal off or vehicle leaves', () => {
  const { act, s, dev } = setup();
  act('blindSpot', { side: 'right', detected: true });
  act('turnSignal', { value: 'right' });
  act('turnSignal', { value: 'off' });
  assert.equal(dev('mirror-right').mode, 'STEADY');
  act('turnSignal', { value: 'right' });
  act('blindSpot', { side: 'right', detected: false });
  assert.equal(dev('mirror-right').mode, 'IDLE');
  assert.equal(s().buzzer, false);
});

test('B3: radar fault -> assist unavailable, no warning', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'mirror-left', fault: true });
  act('blindSpot', { side: 'left', detected: true });
  act('turnSignal', { value: 'left' });
  assert.equal(dev('mirror-left').mode, 'FAULT');
  assert.ok(s().alerts.some((a) => a.title === '左側盲區輔助失效'));
  assert.ok(!s().alerts.some((a) => a.id === 'blindspot-left'));
});
