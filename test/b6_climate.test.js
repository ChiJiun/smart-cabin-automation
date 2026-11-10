'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { hvacAutoLevel } = require('../src/engine/rules');

test('B6: HVAC auto level = clamp(round(|T - 24| / 5), 1, 5)', () => {
  assert.equal(hvacAutoLevel(22, 24), 1);
  assert.equal(hvacAutoLevel(14, 24), 2);
  assert.equal(hvacAutoLevel(36, 24), 2);
  assert.equal(hvacAutoLevel(-6, 24), 5);
  assert.equal(hvacAutoLevel(45, 24), 4);
});

test('B6: temperature changes HVAC level/mode and power', () => {
  const { act, dev, s } = setup();
  act('setAmbient', { celsius: 36 });
  assert.equal(dev('hvac').mode, 'COOLING');
  assert.equal(dev('hvac').level, 2);
  assert.equal(dev('hvac').drawW, 120);
  act('setAmbient', { celsius: -6 });
  assert.equal(dev('hvac').mode, 'HEATING');
  assert.equal(dev('hvac').drawW, 300);
  assert.equal(s().power.demandW, 81 + 300 + 180 + 70); // P0 81 W + HVAC 5 檔 + 除霧 + 音響
});

test('B6: defroster auto on at <= 3 °C, off only above 5 °C', () => {
  const { act, dev } = setup();
  act('setAmbient', { celsius: 4 });
  assert.equal(dev('defroster').on, false);
  act('setAmbient', { celsius: 3 });
  assert.equal(dev('defroster').on, true);
  act('setAmbient', { celsius: 5 });
  assert.equal(dev('defroster').on, true);
  act('setAmbient', { celsius: 6 });
  assert.equal(dev('defroster').on, false);
});

test('B6: manual HVAC level disables auto mode', () => {
  const { act, dev } = setup();
  act('setDevice', { id: 'hvac', level: 4 });
  assert.equal(dev('hvac').auto, false);
  act('setAmbient', { celsius: -10 });
  assert.equal(dev('hvac').level, 4);
});

test('B6: automatic HVAC level changes and defroster switching are written to the log', () => {
  const { act, s } = setup();
  act('setAmbient', { celsius: -6 });
  const msgs = s().log.map((l) => l.message);
  assert.ok(msgs.some((m) => /空調系統：自動依溫差調節 1 → 5 檔（需求 60 → 300 W）/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /車外 -6 °C ≤ 3 °C：自動開啟後擋風除霧/.test(m)));
  act('setAmbient', { celsius: 8 });
  assert.ok(s().log.some((l) => /車外 8 °C > 5 °C：自動關閉後擋風除霧/.test(l.message)));
  // a manual level change is a user action, not an automatic adjustment
  const mark = s().log.length;
  act('setDevice', { id: 'hvac', level: 2 });
  act('setAmbient', { celsius: 40 });
  assert.equal(s().devices.find((d) => d.id === 'hvac').level, 2);
  assert.ok(!s().log.slice(mark).some((l) => /自動依溫差調節/.test(l.message)));
  // re-enabling auto mode is logged as an automatic adjustment again
  act('setDevice', { id: 'hvac', auto: true });
  assert.match(s().log.at(-1).message, /自動依溫差調節 2 → 3 檔（需求 120 → 180 W）/);
});

test('B6: the defroster rule log is written only for an auto-mode defroster', () => {
  const { act, s, dev } = setup();
  act('setDevice', { id: 'defroster', on: false }); // manual override -> auto off
  const mark = s().log.length;
  act('setAmbient', { celsius: 1 });
  assert.equal(dev('defroster').on, false);
  assert.ok(!s().log.slice(mark).some((l) => /自動開啟後擋風除霧/.test(l.message)));
});

test('B6: the HVAC auto log shows the rated demand even when the supply is reduced', () => {
  const { act, s, dev } = setup();
  act('setCapacity', { watts: 250 });
  act('setAmbient', { celsius: -6 });
  assert.equal(dev('hvac').level, 5);
  assert.equal(dev('hvac').effectiveLevel, 1);
  assert.ok(s().log.some((l) => /自動依溫差調節 1 → 5 檔（需求 60 → 300 W）/.test(l.message)));
});

test('B6: a faulted HVAC does not follow the climate rule and logs no automatic adjustment', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'hvac', fault: true });
  const mark = s().log.length;
  act('setAmbient', { celsius: -6 });
  assert.equal(dev('hvac').level, 1);
  assert.equal(dev('hvac').drawW, 0);
  assert.ok(!s().log.slice(mark).some((l) => /自動依溫差調節/.test(l.message)));
  const mark2 = s().log.length;
  act('setFault', { id: 'hvac', fault: false });
  assert.equal(dev('hvac').level, 5);
  assert.ok(s().log.slice(mark2).some((l) => /自動依溫差調節 1 → 5 檔/.test(l.message)));
});

test('B6: a repaired auto defroster catches up with the rule and logs it', () => {
  const { act, s, dev } = setup();
  act('setFault', { id: 'defroster', fault: true });
  act('setAmbient', { celsius: 0 });
  assert.equal(dev('defroster').on, false);
  assert.equal(dev('defroster').drawW, 0);
  const mark = s().log.length;
  act('setFault', { id: 'defroster', fault: false });
  assert.equal(dev('defroster').on, true);
  assert.equal(dev('defroster').drawW, 180);
  assert.ok(s().log.slice(mark).some((l) => l.kind === 'rule' && /車外 0 °C ≤ 3 °C：自動開啟後擋風除霧/.test(l.message)));
});
