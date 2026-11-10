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

test('B4: navigation can be cancelled', () => {
  const { act, s } = setup();
  act('setRange', { km: 25 });
  const near = s().navigationView.recommended[0];
  act('navigate', { stationId: near.id });
  act('cancelNavigation');
  assert.equal(s().navigationView.targetId, null);
  assert.match(s().log.at(-1).message, new RegExp(`取消導航：${near.name}`));
  assert.throws(() => act('cancelNavigation'), /沒有導航目標/);
});

test('B4: a target that falls out of range is dropped automatically; an ECU fault keeps it', () => {
  const { act, s } = setup();
  act('setRange', { km: 25 });
  const rec = s().navigationView.recommended;
  const far = rec[rec.length - 1];
  act('navigate', { stationId: far.id });
  act('setFault', { id: 'ecu', fault: true });
  assert.equal(s().navigationView.targetId, far.id); // range unknown: keep guiding
  act('setFault', { id: 'ecu', fault: false });
  act('setRange', { km: Math.floor(far.distanceKm / 0.9) - 1 });
  assert.equal(s().navigationView.targetId, null);
  assert.ok(s().log.some((l) => l.kind === 'rule' && new RegExp(`導航目標「${far.name}」.*已超出可抵達範圍.*自動取消導航`).test(l.message)));
  assert.ok(s().navigationView.recommended.every((st) => st.id !== far.id));
});

test('B4: without an ECU the range is unknown: no false "no reachable station" advice', () => {
  const { e, act, s } = setup();
  e.deleteDevice('ecu');
  act('setRange', { km: 25 });
  const alerts = s().alerts;
  const unknown = alerts.find((a) => a.id === 'range-unknown');
  assert.ok(unknown);
  assert.equal(unknown.message, '未配置行車電腦');
  assert.ok(!alerts.some((a) => a.id === 'low-range'));
  assert.ok(!alerts.some((a) => /道路救援/.test(a.message)));
  assert.ok(s().navigationView.stations.every((x) => x.reachable === false));
  assert.equal(s().navigationView.recommended.length, 0);
  assert.equal(s().log.filter((l) => l.kind === 'event').at(-1).message, '剩餘里程變為 25 km，但未配置行車電腦，系統無法取得里程');
  assert.throws(() => act('navigate', { stationId: s().navigationView.stations[0].id }), /里程資訊無法取得/);
  // Adding a trip computer back picks up the current range at once.
  e.addDevice({ id: 'ecu', type: 'ecu', name: '行車電腦／里程感測', zone: 'powertrain' });
  assert.ok(s().alerts.some((a) => a.id === 'low-range'));
  assert.ok(s().navigationView.recommended.length > 0);
});

test('B4: a faulted ECU does not report the range and blocks new navigation targets', () => {
  const { act, s } = setup();
  act('setFault', { id: 'ecu', fault: true });
  act('setRange', { km: 25 });
  assert.equal(s().log.filter((l) => l.kind === 'event').at(-1).message, '剩餘里程變為 25 km，但行車電腦故障，系統無法取得里程');
  assert.equal(s().alerts.find((a) => a.id === 'range-unknown').message, '行車電腦故障');
  assert.throws(() => act('navigate', { stationId: s().navigationView.stations[0].id }), /里程資訊無法取得/);
  act('setFault', { id: 'ecu', fault: false });
  assert.ok(s().alerts.some((a) => a.id === 'low-range'));
});
