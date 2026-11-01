'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('B4: range <= 30 km shows warning and reachable stations (distance <= range * 0.9)', () => {
  const { act, s, dev } = setup();
  act('setRange', { km: 31 });
  assert.equal(s().lowRange.active, false);
  act('setRange', { km: 30 });
  assert.equal(s().lowRange.active, true);
  assert.equal(dev('ecu').mode, 'LOW_RANGE_WARNING');
  act('setRange', { km: 25 });
  const rec = s().navigationView.recommended;
  assert.ok(rec.length > 0);
  for (const st of rec) assert.ok(st.distanceKm <= 22.5);
  assert.ok(s().navigationView.stations.some((st) => !st.reachable && st.distanceKm > 22.5));
  // sorted by distance
  assert.deepEqual(rec.map((x) => x.distanceKm), rec.map((x) => x.distanceKm).slice().sort((a, b) => a - b));
});

test('B4: hysteresis — warning clears only above 35 km', () => {
  const { act, s } = setup();
  act('setRange', { km: 25 });
  act('setRange', { km: 33 });
  assert.equal(s().lowRange.active, true);
  act('setRange', { km: 35 });
  assert.equal(s().lowRange.active, true);
  act('setRange', { km: 35.1 });
  assert.equal(s().lowRange.active, false);
});

test('B4: <= 10 km is critical; no reachable station -> roadside assistance', () => {
  const { act, s, dev } = setup();
  act('setRange', { km: 2 });
  assert.equal(dev('ecu').mode, 'CRITICAL_RANGE');
  assert.equal(s().navigationView.recommended.length, 0);
  assert.match(s().alerts.find((a) => a.id === 'low-range').message, /道路救援/);
});

test('B4: navigation only to reachable stations; ECU fault -> range unknown', () => {
  const { act, s } = setup();
  act('setRange', { km: 25 });
  const near = s().navigationView.recommended[0];
  act('navigate', { stationId: near.id });
  assert.equal(s().navigationView.targetId, near.id);
  const far = s().navigationView.stations.find((x) => !x.reachable);
  assert.throws(() => act('navigate', { stationId: far.id }), /超出/);
  act('setFault', { id: 'ecu', fault: true });
  assert.ok(s().alerts.some((a) => a.title === '里程資訊無法取得'));
  assert.equal(s().navigationView.recommended.length, 0);
});
