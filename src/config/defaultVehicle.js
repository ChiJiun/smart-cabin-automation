'use strict';

/**
 * Default vehicle configuration. "Reset" restores runtime state from the current
 * configuration; "Factory reset" also restores this configuration.
 */
const DEFAULT_SETTINGS = {
  capacityW: 1000, // alternator output
  batteryW: 400, // capacity when the alternator has failed
  highLoadPct: 80,
  impactThresholdG: 4.0,
  ecallCountdownS: 10,
  ecallConnectS: 2,
  uploadDurationS: 10,
  lowRangeKm: 30,
  lowRangeClearKm: 35,
  criticalRangeKm: 10,
  reachableFactor: 0.9,
  fuelLPerKm: 0.08,
  targetTempC: 24,
  defrostOnC: 3,
  defrostOffC: 5,
};

const DEFAULT_ZONES = [
  { id: 'front', name: '車頭感知區 (Front Zone)' },
  { id: 'front_cabin', name: '駕駛／前座艙 (Front Cabin)' },
  { id: 'rear_cabin', name: '後座艙 (Rear Cabin)' },
  { id: 'side_rear', name: '側方／後視感知區 (Side / Rear)' },
  { id: 'powertrain', name: '動力感知區 (Powertrain)' },
];

// initial: runtime state applied on reset (on / level / auto / load)
const DEFAULT_DEVICES = [
  { id: 'g-sensor', name: '前碰撞傳感器', type: 'g_sensor', zone: 'front' },
  { id: 'dashcam-front', name: '前行車記錄器', type: 'dashcam', zone: 'front', props: { position: 'front' } },
  { id: 'turn-signal', name: '方向燈控制模組', type: 'turn_signal', zone: 'front_cabin' },
  { id: 'display', name: '車載中控儀表', type: 'display', zone: 'front_cabin' },
  { id: 'ecall', name: '緊急通報模組 (eCall)', type: 'ecall', zone: 'front_cabin' },
  { id: 'hvac', name: '空調系統', type: 'hvac', zone: 'front_cabin', shedOrder: 1, initial: { on: true, auto: true, level: 1 } },
  { id: 'seat-driver', name: '駕駛座椅加熱', type: 'seat_heater', zone: 'front_cabin', shedOrder: 3, initial: { on: false, level: 3 } },
  { id: 'seat-passenger', name: '副駕座椅加熱', type: 'seat_heater', zone: 'front_cabin', shedOrder: 2, initial: { on: false, level: 3 } },
  { id: 'audio', name: '娛樂音響', type: 'audio', zone: 'front_cabin', shedOrder: 5, initial: { on: true, level: 5 } },
  { id: 'seat-rear', name: '後座座椅加熱', type: 'seat_heater', zone: 'rear_cabin', shedOrder: 1, initial: { on: false, level: 3 } },
  { id: 'screen-rear-left', name: '後座娛樂螢幕（左）', type: 'rear_screen', zone: 'rear_cabin', shedOrder: 3 },
  { id: 'screen-rear-right', name: '後座娛樂螢幕（右）', type: 'rear_screen', zone: 'rear_cabin', shedOrder: 4 },
  { id: 'inverter', name: '車用逆變器插座', type: 'inverter', zone: 'rear_cabin', shedOrder: 2, initial: { on: false, load: 200 } },
  { id: 'fridge', name: '車用冰箱', type: 'fridge', zone: 'rear_cabin', shedOrder: 1 },
  { id: 'mirror-left', name: '左電子後視鏡', type: 'mirror', zone: 'side_rear', props: { side: 'left' } },
  { id: 'mirror-right', name: '右電子後視鏡', type: 'mirror', zone: 'side_rear', props: { side: 'right' } },
  { id: 'dashcam-rear', name: '後行車記錄器', type: 'dashcam', zone: 'side_rear', props: { position: 'rear' } },
  { id: 'defroster', name: '後擋風除霧', type: 'defroster', zone: 'side_rear', shedOrder: 2, initial: { on: false, auto: true } },
  { id: 'ecu', name: '行車電腦／里程感測', type: 'ecu', zone: 'powertrain' },
];

const DEFAULT_ENVIRONMENT = {
  ambientTempC: 22,
  rangeKm: 120,
  position: { lat: 25.0330, lng: 121.5654 },
};

module.exports = { DEFAULT_SETTINGS, DEFAULT_ZONES, DEFAULT_DEVICES, DEFAULT_ENVIRONMENT };
