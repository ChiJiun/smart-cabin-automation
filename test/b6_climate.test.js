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
  assert.equal(s().power.demandW, 73 + 300 + 180 + 70);
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
