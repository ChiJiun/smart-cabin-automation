'use strict';

/**
 * Rule modules: derive device modes and alerts from the current inputs.
 * All functions are pure with respect to time — time-based progress (eCall countdown,
 * upload progress) is advanced by Engine.tick().
 */

const DIRECTION_LABEL = { front: '前方', rear: '後方', left: '左側', right: '右側' };
const SIDE_LABEL = { left: '左側', right: '右側' };
// Behavior 1: which emergency service the eCall dials.
const ECALL_SERVICE_LABEL = { 119: '119（救護）', 110: '110（警政）', both: '119（救護）並通報 110（警政）' };

// ---------- Behavior 6: climate ----------
function hvacAutoLevel(ambientC, targetC) {
  const level = Math.round(Math.abs(ambientC - targetC) / 5);
  return Math.min(5, Math.max(1, level));
}

function applyClimate(state) {
  const { ambientTempC } = state.environment;
  const { targetTempC } = state.settings;
  for (const d of state.devices) {
    if (d.type === 'hvac' && d.auto) {
      d.on = true;
      d.level = hvacAutoLevel(ambientTempC, targetTempC);
    }
    if (d.type === 'defroster' && d.auto) {
      d.on = state.climate.defrostActive;
    }
  }
}

// ---------- device modes ----------
function deriveMode(d, state) {
  if (d.fault) return 'FAULT';
  const { sensors, incident, lowRange } = state;
  switch (d.type) {
    case 'g_sensor':
      return incident.active && (!d.props.position || d.props.position === incident.direction) ? 'IMPACT_DETECTED' : 'MONITORING';
    case 'dashcam':
      if (!incident.active) return 'RECORDING';
      if (incident.uploadSource === d.id) return incident.uploadProgress >= 100 ? 'UPLOADED' : 'UPLOADING';
      return 'EMERGENCY_LOCK';
    case 'turn_signal':
      if (sensors.turnSignal === 'left') return 'BLINKING_LEFT';
      if (sensors.turnSignal === 'right') return 'BLINKING_RIGHT';
      return 'IDLE';
    case 'mirror': {
      const side = d.props.side;
      const detected = !!sensors.blindSpot[side];
      if (detected && sensors.turnSignal === side && !turnSignalFaulted(state)) return 'FLASHING';
      if (detected) return 'STEADY';
      return 'IDLE';
    }
    case 'ecall':
      return incident.active ? incident.ecallState : 'STANDBY';
    case 'ecu':
      if (!lowRange.active) return 'NORMAL';
      return state.environment.rangeKm <= state.settings.criticalRangeKm ? 'CRITICAL_RANGE' : 'LOW_RANGE_WARNING';
    case 'hvac':
      if (!d.on) return 'OFF';
      if (state.environment.ambientTempC < state.settings.targetTempC) return 'HEATING';
      if (state.environment.ambientTempC > state.settings.targetTempC) return 'COOLING';
      return 'VENTILATING';
    case 'seat_heater':
      return d.on ? 'HEATING' : 'OFF';
    case 'audio':
      if (!d.on) return 'OFF';
      return muteReasons(state).length > 0 ? 'MUTED' : 'PLAYING';
    case 'inverter':
      return d.on ? 'SUPPLYING' : 'OFF';
    case 'display':
      return 'NORMAL'; // finalised after alerts are known
    default:
      return d.on ? 'ON' : 'OFF';
  }
}

function turnSignalFaulted(state) {
  const ts = state.devices.find((d) => d.type === 'turn_signal');
  return ts ? ts.fault : false;
}

// Behavior 2: audio is muted while any reason is present.
function muteReasons(state) {
  const reasons = [];
  if (state.sensors.siren.active) reasons.push('SIREN');
  if (state.incident.active) reasons.push('COLLISION');
  return reasons;
}

const EMERGENCY_MODES = new Set(['EMERGENCY_LOCK', 'UPLOADING', 'UPLOADED', 'COUNTDOWN', 'CALLING', 'CONNECTED', 'FLASHING', 'IMPACT_DETECTED', 'EMERGENCY', 'CRITICAL_RANGE']);
// 'FAULT' here is the eCall *call* state (the call was interrupted), which outlives a repaired module.
const WARNING_MODES = new Set(['STEADY', 'MUTED', 'LOW_RANGE_WARNING', 'WARNING', 'CANCELLED', 'FAULT']);
// A device the user has switched off is idle: it is in STANDBY (proposal status set:
// Normal, Warning, Emergency, Standby, Shed, Deferred, Fault).
const STANDBY_MODES = new Set(['STANDBY', 'IDLE', 'OFF']);
const STATUSES = ['NORMAL', 'WARNING', 'EMERGENCY', 'STANDBY', 'SHED', 'DEFERRED', 'FAULT'];

function deriveStatus(d) {
  if (d.fault) return 'FAULT';
  if (d.powerState === 'DEFERRED') return 'DEFERRED';
  if (d.powerState === 'SHED') return 'SHED';
  if (EMERGENCY_MODES.has(d.mode)) return 'EMERGENCY';
  if (d.powerState === 'REDUCED' || WARNING_MODES.has(d.mode)) return 'WARNING';
  if (STANDBY_MODES.has(d.mode)) return 'STANDBY';
  return 'NORMAL';
}

// ---------- Behavior 4: stations ----------
function computeNavigation(state, stations, haversineKm) {
  const ecu = state.devices.find((d) => d.type === 'ecu');
  const ecuOk = ecu && !ecu.fault;
  const { rangeKm, position } = state.environment;
  const { reachableFactor, fuelLPerKm } = state.settings;
  const list = stations.map((s) => {
    const distanceKm = Math.round(haversineKm(position, s) * 10) / 10;
    return {
      id: s.id,
      name: s.name,
      distanceKm,
      reachable: ecuOk && distanceKm <= rangeKm * reachableFactor,
      fuelL: Math.round(distanceKm * fuelLPerKm * 100) / 100,
      rangeOnArrivalKm: Math.round((rangeKm - distanceKm) * 10) / 10,
    };
  });
  list.sort((a, b) => a.distanceKm - b.distanceKm);
  const recommended = state.lowRange.active && ecuOk ? list.filter((s) => s.reachable) : [];
  return { stations: list, recommended, targetId: state.navigation.targetId };
}

// ---------- alerts ----------
// Priority: 1 Collision > 2 Blind spot > 3 Siren > 4 Low range > 5 Power > 6 Device faults
function computeAlerts(state, power) {
  const alerts = [];
  const byType = (type) => state.devices.filter((d) => d.type === type);
  const { incident, sensors } = state;

  if (incident.active) {
    const dir = DIRECTION_LABEL[incident.direction] || '';
    const service = ECALL_SERVICE_LABEL[incident.ecallService] || ECALL_SERVICE_LABEL.both;
    let message;
    switch (incident.ecallState) {
      case 'COUNTDOWN': message = `${incident.ecallRemainingS} 秒後自動撥打 ${ECALL_SERVICE_LABEL.both}；可立即選擇撥打 119（救護）或 110（警政），或按「我沒事，取消通報」`; break;
      case 'CALLING': message = `正在撥打 ${service}…`; break;
      case 'CONNECTED': message = `已連線 ${service}，已傳送車輛 GPS 座標與撞擊方向（${dir}）`; break;
      case 'CANCELLED': message = '駕駛已取消緊急通報'; break;
      case 'FAULT': message = `eCall 故障，請手動撥打 ${ECALL_SERVICE_LABEL[119]} 或 ${ECALL_SERVICE_LABEL[110]}`; break;
      default: message = '';
    }
    alerts.push({ id: 'collision', priority: 1, level: 'critical', title: `${dir}撞擊事故（${incident.impactG} g）`, message });
  }

  for (const m of byType('mirror')) {
    if (m.mode === 'FLASHING') {
      alerts.push({ id: `blindspot-${m.props.side}`, priority: 2, level: 'critical', title: `${SIDE_LABEL[m.props.side]}盲區有來車`, message: '請勿變換車道' });
    }
  }

  if (sensors.siren.active) {
    const dir = DIRECTION_LABEL[sensors.siren.direction] || '';
    alerts.push({ id: 'siren', priority: 3, level: 'warning', title: `${dir}有救護車，請注意避讓`, message: '娛樂音響已靜音' });
  }

  const ecuFaulted = byType('ecu').some((d) => d.fault);
  if (ecuFaulted) {
    alerts.push({ id: 'range-unknown', priority: 4, level: 'warning', title: '里程資訊無法取得', message: '行車電腦故障' });
  } else if (state.lowRange.active) {
    const critical = state.environment.rangeKm <= state.settings.criticalRangeKm;
    const n = state.navigationView.recommended.length;
    alerts.push({
      id: 'low-range',
      priority: 4,
      level: critical ? 'critical' : 'warning',
      title: `${critical ? '剩餘里程極低' : '剩餘里程過低'}（${state.environment.rangeKm} km）`,
      message: n > 0 ? `已找到 ${n} 個可抵達的加油站` : '附近無可抵達加油站，建議聯絡道路救援',
    });
  }

  if (state.power.alternatorFault) {
    alerts.push({ id: 'alternator', priority: 5, level: 'warning', title: '發電機異常，電瓶供電中', message: `可用容量降為 ${power.capacityW} W` });
  }
  if (power.status === 'CRITICAL_POWER') {
    alerts.push({ id: 'power', priority: 5, level: 'critical', title: '電力不足，僅維持安全設備', message: `需求 ${power.demandW} W 超過容量 ${power.capacityW} W` });
  } else if (power.status === 'OVERLOAD') {
    const deferred = state.devices.filter((d) => d.powerState === 'DEFERRED').map((d) => d.name);
    const affected = state.devices.filter((d) => d.powerReason === 'OVERLOAD' && d.powerState !== 'DEFERRED').map((d) => d.name);
    const parts = [];
    if (affected.length) parts.push(`已降載／卸載：${affected.join('、')}`);
    if (deferred.length) parts.push(`電力不足，已延後啟動：${deferred.join('、')}`);
    alerts.push({ id: 'power', priority: 5, level: 'warning', title: '電力超載，已啟動負載管理', message: parts.join('；') });
  } else if (power.status === 'HIGH_LOAD') {
    alerts.push({ id: 'power', priority: 5, level: 'warning', title: `用電量偏高（${power.loadPct}%）`, message: `${power.demandW} / ${power.capacityW} W` });
  }

  for (const d of state.devices) {
    if (!d.fault || d.type === 'ecu') continue;
    if (d.type === 'mirror') {
      alerts.push({ id: `fault-${d.id}`, priority: 6, level: 'info', title: `${SIDE_LABEL[d.props.side]}盲區輔助失效`, message: `${d.name} 故障` });
    } else if (d.type === 'ecall' && incident.active) {
      // already covered by the collision alert
    } else {
      alerts.push({ id: `fault-${d.id}`, priority: 6, level: 'info', title: `${d.name} 故障`, message: '設備已停止運作' });
    }
  }

  alerts.sort((a, b) => a.priority - b.priority);
  return alerts;
}

module.exports = {
  hvacAutoLevel, applyClimate, deriveMode, deriveStatus, muteReasons,
  computeNavigation, computeAlerts, DIRECTION_LABEL, ECALL_SERVICE_LABEL, STATUSES,
};
