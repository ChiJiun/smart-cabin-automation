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

test('B3: radar reports DETECTED / CLEAR and the turn signal reports ACTIVE', () => {
  const { act, dev } = setup();
  assert.equal(dev('radar-left').mode, 'CLEAR');
  act('blindSpot', { side: 'left', detected: true });
  assert.equal(dev('radar-left').mode, 'DETECTED');
  assert.equal(dev('radar-left').status, 'WARNING');
  assert.equal(dev('radar-right').mode, 'CLEAR');
  act('turnSignal', { value: 'left' });
  assert.equal(dev('turn-signal').mode, 'ACTIVE_LEFT');
  assert.equal(dev('buzzer').mode, 'ALARM');
  assert.equal(dev('buzzer').status, 'EMERGENCY');
  act('turnSignal', { value: 'off' });
  assert.equal(dev('turn-signal').mode, 'IDLE');
  assert.equal(dev('buzzer').mode, 'SILENT');
});

test('B3: radar fault -> assist unavailable, no warning', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'radar-left', fault: true });
  act('blindSpot', { side: 'left', detected: true });
  act('turnSignal', { value: 'left' });
  assert.equal(dev('radar-left').mode, 'FAULT');
  assert.equal(dev('mirror-left').mode, 'IDLE');
  assert.ok(s().alerts.some((a) => a.title === '左側盲區輔助失效'));
  assert.ok(!s().alerts.some((a) => a.id === 'blindspot-left'));
  assert.equal(s().buzzer, false);
  // the other side keeps working
  act('blindSpot', { side: 'right', detected: true });
  act('turnSignal', { value: 'right' });
  assert.equal(dev('mirror-right').mode, 'FLASHING');
  assert.equal(s().buzzer, true);
});

test('B3: mirror LED fault -> the dashboard warning and buzzer still work', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'mirror-left', fault: true });
  act('blindSpot', { side: 'left', detected: true });
  act('turnSignal', { value: 'left' });
  assert.equal(dev('mirror-left').mode, 'FAULT');
  assert.equal(s().mainAlert.id, 'blindspot-left');
  assert.equal(s().buzzer, true);
  assert.ok(s().alerts.some((a) => a.title === '左側後視鏡 LED 故障'));
});

test('B3: buzzer fault -> LED still flashes, no sound, fault shown', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'buzzer', fault: true });
  act('blindSpot', { side: 'right', detected: true });
  act('turnSignal', { value: 'right' });
  assert.equal(dev('mirror-right').mode, 'FLASHING');
  assert.equal(s().buzzer, false);
  assert.ok(s().alerts.some((a) => a.id === 'blindspot-right'));
  assert.ok(s().alerts.some((a) => a.title === '中控蜂鳴器故障'));
});

test('B3: turn signal fault -> the turn signal cannot be ACTIVE, LED only steady', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'turn-signal', fault: true });
  act('blindSpot', { side: 'left', detected: true });
  act('turnSignal', { value: 'left' });
  assert.equal(dev('mirror-left').mode, 'STEADY');
  assert.equal(s().buzzer, false);
});

test('B3: a cleared alert is logged with the title the driver saw, not its internal id', () => {
  const { act, s } = setup();
  act('blindSpot', { side: 'left', detected: true });
  act('turnSignal', { value: 'left' });
  act('turnSignal', { value: 'off' });
  const msgs = s().log.map((l) => l.message);
  assert.ok(msgs.includes('警示：左側盲區有來車'));
  assert.ok(msgs.includes('警示解除：左側盲區有來車'));
  assert.ok(!msgs.some((m) => m.includes('blindspot-left')));
});
