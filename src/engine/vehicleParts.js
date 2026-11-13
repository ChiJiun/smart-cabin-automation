'use strict';

/**
 * Vehicle parts for the 3D preview: every device belongs to one physical part of the car, and each
 * part reports the most severe condition among the events and devices located there, so the
 * dashboard can highlight the part where something is happening.
 *
 * Levels (least to most severe): ok, info, warning, fault, critical.
 */

const { DIRECTION_LABEL } = require('./rules');

const PARTS = [
  { id: 'front', label: '車頭' },
  { id: 'rear', label: '車尾' },
  { id: 'mirror_left', label: '左後視鏡' },
  { id: 'mirror_right', label: '右後視鏡' },
  { id: 'cabin', label: '座艙' },
  { id: 'chassis', label: '底盤與動力' },
];
const LEVELS = ['ok', 'info', 'warning', 'fault', 'critical'];
const LEVEL_LABEL = { ok: '正常', info: '運作中', warning: '警示', fault: '故障', critical: '危急' };
const SIDE_PART = { left: 'mirror_left', right: 'mirror_right' };
const POSITION_PART = { front: 'front', rear: 'rear' };

// Where a device is mounted. Collision sensors and dashcams sit at the end they cover, the
// blind-spot radars and mirror LEDs on their side, the rear defroster in the rear window and the
// trip computer in the powertrain; everything else is part of the cabin.
function partOfDevice(d) {
  switch (d.type) {
    case 'g_sensor':
    case 'dashcam':
      return POSITION_PART[d.props.position] || 'front';
    case 'defroster':
      return 'rear';
    case 'bsd_radar':
    case 'mirror':
      return SIDE_PART[d.props.side] || 'cabin';
    case 'ecu':
      return 'chassis';
    default:
      return 'cabin';
  }
}

// A removed safety device is reported as a "missing-…" alert; it is shown on the part where it
// would be mounted.
const MISSING_PART = {
  'missing-g_sensor-front': ['front'],
  'missing-g_sensor-rear': ['rear'],
  'missing-dashcam': ['front', 'rear'],
  'missing-bsd_radar-left': ['mirror_left'],
  'missing-mirror-left': ['mirror_left'],
  'missing-bsd_radar-right': ['mirror_right'],
  'missing-mirror-right': ['mirror_right'],
  'missing-ecall': ['cabin'],
  'missing-audio_sensor': ['cabin'],
  'missing-turn_signal': ['cabin'],
  'missing-buzzer': ['cabin'],
  'missing-display': ['cabin'],
};

function deriveVehicleParts(state) {
  const items = Object.fromEntries(PARTS.map((p) => [p.id, []]));
  const add = (part, level, text) => items[part].push({ level, text });
  const { incident, sensors, power } = state;
  const alertIds = new Set(state.alerts.map((a) => a.id));

  // Behavior 1: the struck end, plus the eCall call in the cabin.
  if (incident.active) {
    const part = POSITION_PART[incident.direction];
    if (part) add(part, 'critical', `${DIRECTION_LABEL[incident.direction]}撞擊 ${incident.impactG} g`);
    switch (incident.ecallState) {
      case 'COUNTDOWN': add('cabin', 'critical', `eCall 倒數 ${incident.ecallRemainingS} 秒`); break;
      case 'FAULT':
        if (incident.faultAcknowledged) add('cabin', 'warning', 'eCall 通報中斷（駕駛已確認，自行撥打）');
        else add('cabin', 'critical', 'eCall 通報中斷，請手動撥打 119 或 110');
        break;
      case 'CALLING': add('cabin', 'warning', 'eCall 撥號中'); break;
      case 'CONNECTED': add('cabin', 'info', 'eCall 已連線'); break;
      case 'CANCELLED': add('cabin', 'info', '駕駛已取消通報'); break;
      default:
    }
  }

  // Behavior 2: the siren is shown where it comes from (only once the audio sensor has heard it).
  if (alertIds.has('siren')) {
    const dir = sensors.siren.direction;
    const part = POSITION_PART[dir] || SIDE_PART[dir];
    if (part) add(part, 'warning', `${DIRECTION_LABEL[dir]}有救護車`);
  }

  // Behavior 3: a lane-change conflict is critical, a vehicle in the blind spot alone is a warning.
  for (const side of ['left', 'right']) {
    if (alertIds.has(`blindspot-${side}`)) {
      add(SIDE_PART[side], 'critical', '盲區有來車，請勿變換車道');
    } else if (state.devices.some((d) => d.type === 'bsd_radar' && d.props.side === side && !d.fault && d.mode === 'DETECTED')) {
      add(SIDE_PART[side], 'warning', '盲區有車');
    }
  }

  // Behavior 4: the range reaches the system through the trip computer in the powertrain.
  const range = state.alerts.find((a) => a.id === 'low-range' || a.id === 'range-unknown');
  if (range) add('chassis', range.level === 'critical' ? 'critical' : 'warning', range.title);
  if (state.navigationView && state.navigationView.targetId) {
    const st = state.navigationView.stations.find((x) => x.id === state.navigationView.targetId);
    if (st) add('chassis', 'info', `導航至 ${st.name}`);
  }

  // Behavior 5: the power budget is managed for the cabin loads.
  if (power.status === 'CRITICAL_POWER') add('cabin', 'critical', '電力不足，僅維持安全設備');
  else if (power.status === 'OVERLOAD') add('cabin', 'warning', `電力超載（需求 ${power.requestedPct}%）`);
  else if (power.status === 'HIGH_LOAD') add('cabin', 'warning', `用電量偏高（${power.loadPct}%）`); // a warning on the dashboard too
  if (power.alternatorFault) add('chassis', 'warning', '發電機異常，電瓶供電中');

  // Devices: faults, and outputs that are working right now.
  for (const d of state.devices) {
    const part = partOfDevice(d);
    if (d.fault) add(part, 'fault', `${d.name} 故障`);
    else if (d.type === 'dashcam' && d.mode === 'UPLOADING') add(part, 'info', `${d.name} 上傳影像中`);
    else if (d.type === 'dashcam' && d.mode === 'EMERGENCY_LOCK') add(part, 'info', `${d.name} 鎖定保存`);
    else if (d.type === 'defroster' && d.on) add(part, 'info', `${d.name} 運作中`);
    else if (d.type === 'audio' && d.mode === 'MUTED') add(part, 'info', `${d.name} 靜音`);
  }

  for (const a of state.alerts) {
    for (const part of MISSING_PART[a.id] || []) add(part, 'warning', a.message);
  }

  return PARTS.map((p) => {
    const list = items[p.id].sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level));
    const level = list.length ? list[0].level : 'ok';
    return {
      id: p.id,
      label: p.label,
      level,
      levelLabel: LEVEL_LABEL[level],
      summary: list.length ? list[0].text : '正常',
      items: list,
      devices: state.devices.filter((d) => partOfDevice(d) === p.id).map((d) => ({ id: d.id, name: d.name, status: d.status, mode: d.mode })),
    };
  });
}

module.exports = { deriveVehicleParts, partOfDevice, PARTS, LEVELS };
