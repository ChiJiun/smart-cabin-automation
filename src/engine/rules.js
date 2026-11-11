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

// ---------- sensors ----------
// A reading only counts when a working sensor of the right kind reports it.
const healthy = (state, type, pred = () => true) => state.devices.some((d) => d.type === type && !d.fault && pred(d));

// Behavior 2: the audio sensor picks up the emergency-vehicle siren (and its bearing).
function sirenDetected(state) {
  return !!state.sensors.siren.active && healthy(state, 'audio_sensor');
}

// Behavior 3: blind-spot radar reports DETECTED; the turn signal on that side is ACTIVE.
function radarDetects(state, side) {
  return !!state.sensors.blindSpot[side] && healthy(state, 'bsd_radar', (d) => d.props.side === side);
}
function turnSignalActive(state, side) {
  return state.sensors.turnSignal === side && healthy(state, 'turn_signal');
}
function laneChangeConflict(state, side) {
  return radarDetects(state, side) && turnSignalActive(state, side);
}

// The dashboard buzzer sounds continuously during a lane-change conflict (Behavior 3). After a
// collision it also sounds while the eCall countdown waits for the driver (call 119 / 110 or cancel),
// and when the automatic call cannot be made (eCall module faulted or missing) until the driver
// acknowledges that they will dial manually.
function buzzerDemanded(state) {
  const { incident } = state;
  return (incident.active && incident.ecallState === 'COUNTDOWN')
    || (incident.active && incident.ecallState === 'FAULT' && !incident.faultAcknowledged)
    || ['left', 'right'].some((side) => laneChangeConflict(state, side));
}

// ---------- Behavior 6: climate ----------
function hvacAutoLevel(ambientC, targetC) {
  const level = Math.round(Math.abs(ambientC - targetC) / 5);
  return Math.min(5, Math.max(1, level));
}

function applyClimate(state) {
  const { ambientTempC } = state.environment;
  const { targetTempC } = state.settings;
  for (const d of state.devices) {
    if (d.fault) continue; // a faulted unit cannot follow the rule (and must not log adjustments)
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
    case 'audio_sensor':
      return sensors.siren.active ? 'SIREN_DETECTED' : 'LISTENING';
    case 'bsd_radar':
      return sensors.blindSpot[d.props.side] ? 'DETECTED' : 'CLEAR';
    case 'turn_signal':
      if (sensors.turnSignal === 'left') return 'ACTIVE_LEFT';
      if (sensors.turnSignal === 'right') return 'ACTIVE_RIGHT';
      return 'IDLE';
    case 'mirror': {
      const side = d.props.side;
      if (laneChangeConflict(state, side)) return 'FLASHING';
      if (radarDetects(state, side)) return 'STEADY';
      return 'IDLE';
    }
    case 'buzzer':
      return buzzerDemanded(state) ? 'ALARM' : 'SILENT';
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

// Behavior 2: audio is muted while any reason is present.
function muteReasons(state) {
  const reasons = [];
  if (sirenDetected(state)) reasons.push('SIREN');
  if (state.incident.active) reasons.push('COLLISION');
  return reasons;
}

const EMERGENCY_MODES = new Set(['EMERGENCY_LOCK', 'UPLOADING', 'UPLOADED', 'COUNTDOWN', 'CALLING', 'CONNECTED', 'FLASHING', 'ALARM', 'IMPACT_DETECTED', 'EMERGENCY', 'CRITICAL_RANGE']);
// 'FAULT' here is the eCall *call* state (the call was interrupted), which outlives a repaired module.
const WARNING_MODES = new Set(['STEADY', 'DETECTED', 'SIREN_DETECTED', 'MUTED', 'LOW_RANGE_WARNING', 'WARNING', 'CANCELLED', 'FAULT']);
// A device the user has switched off is idle: it is in STANDBY (proposal status set:
// Normal, Warning, Emergency, Standby, Shed, Deferred, Fault).
const STANDBY_MODES = new Set(['STANDBY', 'IDLE', 'SILENT', 'OFF']);
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

// A zone reports the most severe status among its devices (an empty zone is on standby).
const ZONE_SEVERITY = ['STANDBY', 'NORMAL', 'DEFERRED', 'SHED', 'WARNING', 'FAULT', 'EMERGENCY'];
function deriveZoneStatus(devices) {
  let worst = 'STANDBY';
  for (const d of devices) if (ZONE_SEVERITY.indexOf(d.status) > ZONE_SEVERITY.indexOf(worst)) worst = d.status;
  return worst;
}

// System level: an active collision raises the whole system to CRITICAL_EMERGENCY (Behavior 1).
const SYSTEM_LEVELS = ['NORMAL', 'WARNING', 'CRITICAL', 'CRITICAL_EMERGENCY'];
function deriveSystemLevel(state) {
  if (state.incident.active) return 'CRITICAL_EMERGENCY';
  if (state.alerts.some((a) => a.level === 'critical')) return 'CRITICAL';
  if (state.alerts.some((a) => a.level === 'warning') || state.devices.some((d) => d.fault && d.priority === 0)) return 'WARNING';
  return 'NORMAL';
}

// ---------- Behavior 4: stations ----------
// The range reaches the system through the trip computer (ECU). Without a working one (faulted or
// not configured) the range is unknown, so no station can be judged reachable.
function ecuAvailable(state) {
  return healthy(state, 'ecu');
}

function computeNavigation(state, stations, haversineKm) {
  const ecuOk = ecuAvailable(state);
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
  return { stations: list, recommended, targetId: state.navigation.targetId, reachableKm: Math.round(rangeKm * reachableFactor * 10) / 10 };
}

// ---------- missing safety devices ----------
// A safety function whose device is not configured at all (removed on the configuration page) is
// reported like a faulted one, so the driver is not left without a warning. The trip computer is
// covered by the range-unknown alert.
const covers = (state, type, pred = () => true) => state.devices.some((d) => d.type === type && pred(d));
const MISSING_CHECKS = [
  ...['front', 'rear'].map((pos) => ({
    id: `g_sensor-${pos}`,
    missing: (s) => !covers(s, 'g_sensor', (d) => !d.props.position || d.props.position === pos),
    title: `${DIRECTION_LABEL[pos]}撞擊偵測失效`,
    message: `未配置${DIRECTION_LABEL[pos]}碰撞傳感器，${DIRECTION_LABEL[pos]}撞擊無法偵測`,
  })),
  { id: 'dashcam', missing: (s) => !covers(s, 'dashcam'), title: '事故影像無法存證', message: '未配置行車記錄器' },
  { id: 'ecall', missing: (s) => !covers(s, 'ecall'), title: '緊急通報無法使用', message: '未配置 eCall 模組，事故時請手動撥打 119 或 110' },
  { id: 'audio_sensor', missing: (s) => !covers(s, 'audio_sensor'), title: '救護車笛聲偵測失效', message: '未配置音訊傳感器' },
  ...['left', 'right'].flatMap((side) => [
    {
      id: `bsd_radar-${side}`,
      missing: (s) => !covers(s, 'bsd_radar', (d) => d.props.side === side),
      title: `${SIDE_LABEL[side]}盲區輔助失效`,
      message: `未配置${SIDE_LABEL[side]}盲區雷達，無法偵測盲區來車`,
    },
    {
      id: `mirror-${side}`,
      missing: (s) => !covers(s, 'mirror', (d) => d.props.side === side),
      title: `${SIDE_LABEL[side]}後視鏡 LED 無法警示`,
      message: `未配置${SIDE_LABEL[side]}電子後視鏡，盲區警示改由儀表與蜂鳴器提示`,
    },
  ]),
  { id: 'turn_signal', missing: (s) => !covers(s, 'turn_signal'), title: '方向燈訊號無法取得', message: '未配置方向燈控制模組，變換車道時的盲區警示無法運作' },
  { id: 'buzzer', missing: (s) => !covers(s, 'buzzer'), title: '警示音無法發出', message: '未配置中控蜂鳴器，請留意儀表警示' },
  { id: 'display', missing: (s) => !covers(s, 'display'), title: '中控儀表未配置', message: '未配置車載中控儀表，警示僅記錄於日誌' },
];

function missingSafetyFunctions(state) {
  return MISSING_CHECKS.filter((c) => c.missing(state));
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

  for (const side of ['left', 'right']) {
    if (laneChangeConflict(state, side)) {
      alerts.push({ id: `blindspot-${side}`, priority: 2, level: 'critical', title: `${SIDE_LABEL[side]}盲區有來車`, message: '請勿變換車道' });
    }
  }

  if (sirenDetected(state)) {
    const dir = DIRECTION_LABEL[sensors.siren.direction] || '';
    alerts.push({ id: 'siren', priority: 3, level: 'warning', title: `${dir}有救護車，請注意避讓`, message: '娛樂音響已靜音' });
  }

  if (!ecuAvailable(state)) {
    const configured = byType('ecu').length > 0;
    alerts.push({ id: 'range-unknown', priority: 4, level: 'warning', title: '里程資訊無法取得', message: configured ? '行車電腦故障' : '未配置行車電腦' });
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
    const parts = [`需求負載率 ${power.requestedPct}%（${power.requestedW} / ${power.capacityW} W）`];
    if (affected.length) parts.push(`已降載／卸載：${affected.join('、')}`);
    if (deferred.length) parts.push(`電力不足，已延後啟動：${deferred.join('、')}`);
    alerts.push({ id: 'power', priority: 5, level: 'warning', title: '電力超載，已啟動負載管理', message: parts.join('；') });
  } else if (power.status === 'HIGH_LOAD') {
    alerts.push({ id: 'power', priority: 5, level: 'warning', title: `用電量偏高（${power.loadPct}%）`, message: `${power.demandW} / ${power.capacityW} W` });
  }

  for (const d of state.devices) {
    if (!d.fault || (d.type === 'ecu' && !ecuAvailable(state))) continue; // range-unknown already covers it
    const side = SIDE_LABEL[d.props.side] || '';
    const sameSide = (x) => x.props.side === d.props.side;
    // With a working spare of the same role (configured on the configuration page) the function
    // keeps running, so only the faulted unit is reported.
    const spare = { title: `${d.name} 故障`, message: '同類備援設備仍在運作' };
    let a;
    if (d.type === 'bsd_radar') {
      a = healthy(state, 'bsd_radar', sameSide) ? spare : { title: `${side}盲區輔助失效`, message: `${d.name} 故障，無法偵測盲區來車` };
    } else if (d.type === 'mirror') {
      a = { title: `${side}後視鏡 LED 故障`, message: healthy(state, 'bsd_radar', sameSide) ? '盲區警示改由儀表與蜂鳴器提示' : `${d.name} 故障` };
    } else if (d.type === 'audio_sensor') {
      a = healthy(state, 'audio_sensor') ? spare : { title: '救護車笛聲偵測失效', message: `${d.name} 故障` };
    } else if (d.type === 'buzzer') {
      a = healthy(state, 'buzzer') ? spare : { title: `${d.name}故障`, message: '警示音無法發出，請留意儀表警示' };
    }
    if (a) {
      alerts.push({ id: `fault-${d.id}`, priority: 6, level: 'info', ...a });
    } else if (d.type === 'ecall' && incident.active && incident.ecallState === 'FAULT') {
      // the collision alert already tells the driver to dial manually
    } else {
      alerts.push({ id: `fault-${d.id}`, priority: 6, level: 'info', title: `${d.name} 故障`, message: '設備已停止運作' });
    }
  }

  for (const c of missingSafetyFunctions(state)) {
    // During an incident without an eCall module the collision alert already says to dial manually.
    if (c.id === 'ecall' && incident.active) continue;
    alerts.push({ id: `missing-${c.id}`, priority: 6, level: 'warning', title: c.title, message: c.message });
  }

  alerts.sort((a, b) => a.priority - b.priority);
  return alerts;
}

module.exports = {
  hvacAutoLevel, applyClimate, deriveMode, deriveStatus, deriveZoneStatus, deriveSystemLevel, muteReasons,
  sirenDetected, radarDetects, turnSignalActive, laneChangeConflict, ecuAvailable, missingSafetyFunctions,
  computeNavigation, computeAlerts, DIRECTION_LABEL, ECALL_SERVICE_LABEL, STATUSES, SYSTEM_LEVELS,
};
