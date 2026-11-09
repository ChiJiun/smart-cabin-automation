'use strict';

/**
 * Device type registry.
 *
 * fixedPriority : safety devices are always P0 and can never be shed.
 * defaultPriority: priority used when a device of this type is created (P1–P3 editable).
 * adjustable    : device has a level (HVAC fan level, seat heater level, audio volume).
 * userControl   : driver / passenger can switch it on/off from the dashboard.
 * ratedW        : on-power for simple devices, per-level power for adjustable devices.
 */
const DEVICE_TYPES = {
  g_sensor: { label: '碰撞傳感器 (G-Sensor)', fixedPriority: 0, ratedW: 5, props: ['position'] },
  dashcam: { label: '行車記錄器 (Dashcam)', fixedPriority: 0, ratedW: 8, uploadW: 48, props: ['position'] },
  turn_signal: { label: '方向燈控制模組', fixedPriority: 0, ratedW: 2, activeW: 40 },
  display: { label: '車載中控儀表', fixedPriority: 0, ratedW: 25 },
  ecall: { label: '緊急通報模組 (eCall)', fixedPriority: 0, ratedW: 3, activeW: 45 },
  mirror: { label: '電子後視鏡 (盲區雷達/LED)', fixedPriority: 0, ratedW: 6, activeW: 10, props: ['side'] },
  ecu: { label: '行車電腦/里程感測 (ECU)', fixedPriority: 0, ratedW: 10 },
  hvac: {
    label: '空調系統 (HVAC)', defaultPriority: 1, ratedW: 60,
    adjustable: true, minLevel: 1, maxLevel: 5, userControl: true, auto: true,
  },
  seat_heater: {
    label: '座椅加熱', defaultPriority: 2, ratedW: 45,
    adjustable: true, minLevel: 1, maxLevel: 3, userControl: true,
  },
  defroster: { label: '後擋風除霧', defaultPriority: 1, ratedW: 180, userControl: true, auto: true },
  audio: {
    label: '娛樂音響', defaultPriority: 3, ratedW: 12, baseW: 10,
    adjustable: true, minLevel: 0, maxLevel: 10, userControl: true,
  },
  rear_screen: { label: '後座娛樂螢幕', defaultPriority: 3, ratedW: 30, userControl: true },
  inverter: { label: '車用逆變器插座', defaultPriority: 3, variableLoad: true, maxLoad: 300, userControl: true },
  fridge: { label: '車用冰箱', defaultPriority: 3, ratedW: 60, userControl: true },
};

const SAFETY_TYPES = Object.keys(DEVICE_TYPES).filter((t) => DEVICE_TYPES[t].fixedPriority === 0);

function getType(type) {
  const t = DEVICE_TYPES[type];
  if (!t) throw new Error(`Unknown device type: ${type}`);
  return t;
}

/**
 * Power a device would draw in the given mode at the given level (before load management).
 */
function drawFor(device, mode, level) {
  const t = getType(device.type);
  if (device.fault) return 0;
  switch (device.type) {
    case 'dashcam':
      return mode === 'UPLOADING' ? t.uploadW : device.ratedW;
    case 'turn_signal':
      return mode.startsWith('BLINKING') ? t.activeW : device.ratedW;
    case 'mirror':
      return mode === 'FLASHING' ? t.activeW : device.ratedW;
    case 'ecall':
      return mode === 'CALLING' || mode === 'CONNECTED' ? t.activeW : device.ratedW;
    case 'hvac':
    case 'seat_heater':
      return device.on && level > 0 ? device.ratedW * level : 0;
    case 'audio':
      if (!device.on) return 0;
      return t.baseW + (mode === 'MUTED' ? 0 : device.ratedW * level);
    case 'inverter':
      return device.on ? device.load : 0;
    default:
      if (t.userControl) return device.on ? device.ratedW : 0;
      return device.ratedW;
  }
}

module.exports = { DEVICE_TYPES, SAFETY_TYPES, getType, drawFor };
