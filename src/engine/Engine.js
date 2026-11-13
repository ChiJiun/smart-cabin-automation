'use strict';

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { DEVICE_TYPES, getType } = require('./deviceTypes');
const { allocatePower } = require('./powerManager');
const rules = require('./rules');
const { deriveVehicleParts } = require('./vehicleParts');
const defaults = require('../config/defaultVehicle');
const { STATIONS, haversineKm } = require('../config/stations');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const LOG_LIMIT = 2000; // kept in memory for export; the dashboard shows the most recent entries

const fmtSimTime = (t) => `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

function assert(cond, message) {
  if (!cond) throw new ValidationError(message);
}

function num(value, name, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = Number(value);
  const given = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  assert(given && Number.isFinite(n), `${name} 必須是數字`);
  assert(n >= min && n <= max, `${name} 必須介於 ${min} 與 ${max} 之間`);
  if (integer) assert(Number.isInteger(n), `${name} 必須是整數`);
  return n;
}

function bool(value, name) {
  assert(typeof value === 'boolean', `${name} 必須是 true 或 false`);
  return value;
}

// Lookup tables are plain objects: only their own keys are valid (not "constructor", "__proto__"...).
const own = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

// Ids become object keys (snapshots, lookups), so names inherited from Object.prototype are refused.
const RESERVED_ID = (id) => id in Object.prototype;

// Valid range and label of each system setting (configuration page).
const SETTING_RANGES = {
  capacityW: { label: '發電機容量', min: 0, max: 10000 },
  batteryW: { label: '電瓶供電容量', min: 0, max: 10000 },
  highLoadPct: { label: '高負載門檻', min: 1, max: 100 },
  impactThresholdG: { label: '撞擊閾值', min: 0.1, max: 100 },
  ecallCountdownS: { label: 'eCall 倒數秒數', min: 0, max: 600, integer: true },
  ecallConnectS: { label: 'eCall 撥號秒數', min: 0, max: 600, integer: true },
  uploadDurationS: { label: '影像上傳秒數', min: 1, max: 600, integer: true },
  lowRangeKm: { label: '低里程門檻', min: 0, max: 1500 },
  lowRangeClearKm: { label: '低里程解除門檻', min: 0, max: 1500 },
  criticalRangeKm: { label: '極低里程門檻', min: 0, max: 1500 },
  reachableFactor: { label: '可抵達係數', min: 0.01, max: 1 },
  fuelLPerKm: { label: '油耗', min: 0, max: 10 },
  targetTempC: { label: '目標溫度', min: 10, max: 35 },
  defrostOnC: { label: '除霧開啟溫度', min: -40, max: 40 },
  defrostOffC: { label: '除霧關閉溫度', min: -40, max: 40 },
};

/**
 * Central Incident Logic Unit + Power Manager + Simulation Clock.
 *
 * All inputs go through dispatch(action). After every input or clock tick the engine
 * re-derives device modes, power allocation, statuses and alerts (evaluate()), logs
 * every observable change, and emits 'change'.
 */
class Engine extends EventEmitter {
  constructor() {
    super();
    // Identifies this server run: a dashboard that reconnects after a restart accepts the new
    // (lower) state revisions instead of treating them as stale.
    this._bootId = randomUUID();
    this.config = {
      settings: clone(defaults.DEFAULT_SETTINGS),
      zones: clone(defaults.DEFAULT_ZONES),
      devices: defaults.DEFAULT_DEVICES.map((d) => this._normaliseDeviceConfig(d)),
    };
    this.reset();
  }

  // ---------------------------------------------------------------- state
  reset() {
    const settings = clone(this.config.settings);
    const env = clone(defaults.DEFAULT_ENVIRONMENT);
    this.state = {
      simTime: 0,
      clockRunning: this.state ? this.state.clockRunning : true,
      settings,
      environment: env,
      climate: { defrostActive: env.ambientTempC <= settings.defrostOnC },
      power: { alternatorFault: false },
      sensors: { siren: { active: false, direction: 'rear' }, blindSpot: { left: false, right: false }, turnSignal: 'off' },
      incident: this._idleIncident(),
      lowRange: { active: env.rangeKm <= settings.lowRangeKm },
      navigation: { targetId: null },
      devices: this.config.devices.map((c) => this._createRuntimeDevice(c)),
      log: [],
    };
    this._prevSnapshot = null;
    this._log('system', '系統重置：載入預設狀態');
    this.evaluate();
  }

  factoryReset() {
    this.config = {
      settings: clone(defaults.DEFAULT_SETTINGS),
      zones: clone(defaults.DEFAULT_ZONES),
      devices: defaults.DEFAULT_DEVICES.map((d) => this._normaliseDeviceConfig(d)),
    };
    this.state = null;
    this.reset();
    this.state.clockRunning = true;
  }

  _idleIncident() {
    return {
      id: null, active: false, direction: null, impactG: null, startedAt: null,
      ecallState: 'STANDBY', ecallService: null, ecallRemainingS: null, callStartedAt: null, connectedAt: null,
      faultAcknowledged: false,
      uploadSource: null, uploadProgress: 0, uploadDone: false,
    };
  }

  _normaliseDeviceConfig(d) {
    const t = getType(d.type);
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      zone: d.zone,
      priority: t.fixedPriority === 0 ? 0 : (d.priority ?? t.defaultPriority),
      shedOrder: d.shedOrder ?? 99,
      ratedW: d.ratedW ?? t.ratedW ?? 0,
      props: { ...(d.props || {}) },
      initial: {
        on: d.initial?.on ?? !t.userControl,
        level: d.initial?.level ?? (t.adjustable ? t.minLevel : 0),
        auto: d.initial?.auto ?? false,
        load: d.initial?.load ?? (t.variableLoad ? 100 : 0),
      },
    };
  }

  _createRuntimeDevice(c) {
    return {
      id: c.id, name: c.name, type: c.type, zone: c.zone, priority: c.priority,
      shedOrder: c.shedOrder, ratedW: c.ratedW, props: { ...c.props },
      on: c.initial.on, level: c.initial.level, auto: c.initial.auto, load: c.initial.load,
      fault: false, poweredSinceOn: true,
      mode: 'OFF', status: 'STANDBY', effectiveLevel: c.initial.level, drawW: 0, powerState: 'NORMAL', powerReason: null,
    };
  }

  device(id) {
    const d = this.state.devices.find((x) => x.id === id);
    assert(d, `找不到設備：${id}`);
    return d;
  }

  capacityW() {
    const s = this.state.settings;
    return this.state.power.alternatorFault ? s.batteryW : s.capacityW;
  }

  // ---------------------------------------------------------------- evaluate
  evaluate() {
    const s = this.state;
    this._reconcileIncident();
    rules.applyClimate(s);
    for (const d of s.devices) d.mode = rules.deriveMode(d, s);
    const power = allocatePower(s.devices, {
      capacityW: this.capacityW(),
      highLoadPct: s.settings.highLoadPct,
      emergency: s.incident.active,
    });
    s.power = { ...s.power, ...power };
    s.navigationView = rules.computeNavigation(s, STATIONS, haversineKm);
    this._reconcileNavigation();
    s.alerts = rules.computeAlerts(s, power);
    s.mainAlert = s.alerts[0] || null;
    s.buzzer = s.devices.some((d) => d.type === 'buzzer' && d.mode === 'ALARM');
    s.systemLevel = rules.deriveSystemLevel(s);
    for (const d of s.devices) {
      if (d.type === 'display' && !d.fault) {
        d.mode = !s.mainAlert ? 'NORMAL' : s.mainAlert.level === 'critical' ? 'EMERGENCY' : s.mainAlert.level === 'warning' ? 'WARNING' : 'NORMAL';
      }
      d.status = rules.deriveStatus(d);
    }
    s.zoneStatus = Object.fromEntries(this.config.zones.map((z) => [z.id, rules.deriveZoneStatus(s.devices.filter((d) => d.zone === z.id))]));
    s.vehicleParts = deriveVehicleParts(s); // 3D preview: which part of the car is affected
    this._logChanges();
    // Every evaluation gets a new revision, so a dashboard can tell an older state (a slow POST
    // response) from a newer one it already received over SSE.
    this._rev = (this._rev || 0) + 1;
    this.emit('change');
  }

  _snapshot() {
    const s = this.state;
    const devices = {};
    for (const d of s.devices) devices[d.id] = { type: d.type, mode: d.mode, on: d.on, powerState: d.powerState, effectiveLevel: d.effectiveLevel, level: d.level, auto: d.auto, ratedW: d.ratedW, name: d.name };
    return { devices, powerStatus: s.power.status, systemLevel: s.systemLevel, alerts: s.alerts.map((a) => a.id + '|' + a.title) };
  }

  _logChanges() {
    const now = this._snapshot();
    const prev = this._prevSnapshot;
    this._prevSnapshot = now;
    if (!prev) return;
    const { ambientTempC } = this.state.environment;
    const st = this.state.settings;
    if (prev.systemLevel !== now.systemLevel) this._log('system', `系統等級：${prev.systemLevel} → ${now.systemLevel}`);
    for (const [id, d] of Object.entries(now.devices)) {
      const p = prev.devices[id];
      if (!p) continue;
      // Behavior 6: whatever the climate rule decides in auto mode is logged (cause before effect) so
      // the TA can trace it. Watts are the level's rated demand; the actual, possibly reduced, supply
      // is covered by the power log.
      if (d.auto && p.level !== d.level) this._log('rule', `${d.name}：自動依溫差調節 ${p.level} → ${d.level} 檔（需求 ${p.level * d.ratedW} → ${d.level * d.ratedW} W）`);
      if (d.type === 'defroster' && d.auto && p.on !== d.on) {
        // Inside the hysteresis band (on-threshold < T <= off-threshold) the rule keeps the last decision,
        // e.g. when a defroster is switched back to auto there.
        let why;
        if (d.on) why = ambientTempC <= st.defrostOnC ? `車外 ${ambientTempC} °C ≤ ${st.defrostOnC} °C` : `車外 ${ambientTempC} °C 在遲滯區間（> ${st.defrostOffC} °C 才關閉）`;
        else why = ambientTempC > st.defrostOffC ? `車外 ${ambientTempC} °C > ${st.defrostOffC} °C` : `車外 ${ambientTempC} °C 在遲滯區間（≤ ${st.defrostOnC} °C 才開啟）`;
        this._log('rule', `${why}：自動${d.on ? '開啟' : '關閉'}${d.name}`);
      }
      if (p.mode !== d.mode) this._log('device', `${d.name}：${p.mode} → ${d.mode}`);
      if (p.powerState !== d.powerState || p.effectiveLevel !== d.effectiveLevel) {
        if (p.powerState !== d.powerState || d.powerState === 'REDUCED') {
          const lvl = d.powerState === 'REDUCED' ? `（檔位 ${d.effectiveLevel}）` : '';
          this._log('power', `${d.name}：供電 ${p.powerState} → ${d.powerState}${lvl}`);
        }
      }
    }
    if (prev.powerStatus !== now.powerStatus) this._log('power', `電力狀態：${prev.powerStatus} → ${now.powerStatus}`);
    // Alerts are snapshotted as "id|title" (ids never contain "|"; titles may, as device names are
    // user-editable). A cleared alert is logged with the title the driver saw, not its internal id.
    const idOf = (a) => a.slice(0, a.indexOf('|'));
    const titleOf = (a) => a.slice(a.indexOf('|') + 1);
    const nowIds = new Set(now.alerts.map(idOf));
    for (const a of now.alerts.filter((x) => !prev.alerts.includes(x))) this._log('alert', `警示：${titleOf(a)}`);
    for (const a of prev.alerts.filter((x) => !nowIds.has(idOf(x)))) this._log('alert', `警示解除：${titleOf(a)}`);
  }

  _log(kind, message) {
    const log = this.state.log;
    log.push({ seq: (log.length ? log[log.length - 1].seq : 0) + 1, t: this.state.simTime, kind, message });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  }

  // ---------------------------------------------------------------- clock
  tick(seconds = 1) {
    for (let i = 0; i < seconds; i++) {
      this.state.simTime += 1;
      this._advanceIncident();
      this.evaluate();
    }
  }

  _advanceIncident() {
    const inc = this.state.incident;
    const st = this.state.settings;
    if (!inc.active) return;
    if (inc.ecallState === 'COUNTDOWN') {
      inc.ecallRemainingS -= 1;
      if (inc.ecallRemainingS <= 0) {
        inc.ecallRemainingS = 0;
        // No choice made during the countdown: call 119 and notify 110.
        inc.ecallService = inc.ecallService || 'both';
        this._log('rule', `eCall 倒數結束，未選擇撥打對象：自動撥打 ${rules.ECALL_SERVICE_LABEL.both}`);
        this._startCall();
      }
    }
    if (inc.ecallState === 'CALLING' && this.state.simTime - inc.callStartedAt >= st.ecallConnectS) {
      this._connectCall();
    }
    if (inc.uploadSource && inc.uploadProgress < 100) {
      const src = this.state.devices.find((d) => d.id === inc.uploadSource);
      if (src) inc.uploadProgress = Math.min(100, inc.uploadProgress + 100 / st.uploadDurationS);
    }
  }

  /**
   * Keep the incident consistent with the device topology on every evaluation (not only on a
   * clock tick, so the TA sees the effect immediately while the clock is paused):
   *  - the eCall module failing during COUNTDOWN / CALLING interrupts the call (FAULT);
   *  - the upload source failing hands the upload to another dashcam;
   *  - a dashcam becoming available again resumes an upload that had no source.
   */
  _reconcileIncident() {
    const inc = this.state.incident;
    if (!inc.active) return;
    if ((inc.ecallState === 'COUNTDOWN' || inc.ecallState === 'CALLING') && this._ecallFaulted()) {
      inc.ecallState = 'FAULT';
      inc.ecallRemainingS = 0;
      const present = this.state.devices.some((d) => d.type === 'ecall');
      this._log('rule', `${present ? 'eCall 模組故障' : 'eCall 模組已移除'}，自動通報中斷：請手動撥打 119（救護）或 110（警政）`);
    }
    if (inc.uploadProgress < 100 && !inc.uploadDone) {
      const src = inc.uploadSource ? this.state.devices.find((d) => d.id === inc.uploadSource) : null;
      if (src && src.fault) this._reassignUploadSource(`「${src.name}」上傳中故障`);
      else if (!src) {
        const next = this._pickUploadSource(inc.direction);
        if (next) {
          inc.uploadSource = next.id;
          inc.uploadProgress = 0;
          this._log('rule', `「${next.name}」可用，開始上傳影像`);
        } else if (inc.uploadSource) {
          inc.uploadSource = null;
        }
      }
    }
  }

  /**
   * Behavior 4: a navigation target that is no longer reachable with the remaining range is dropped
   * (the driver is shown the stations that are still reachable). While no working ECU reports the
   * range (faulted or not configured) the range is unknown, so the chosen target is kept.
   */
  _reconcileNavigation() {
    const s = this.state;
    const id = s.navigation.targetId;
    if (!id) return;
    if (!rules.ecuAvailable(s)) return;
    const st = s.navigationView.stations.find((x) => x.id === id);
    if (st && st.reachable) return;
    s.navigation.targetId = null;
    this._log('rule', st
      ? `導航目標「${st.name}」（${st.distanceKm} km）已超出可抵達範圍（${s.navigationView.reachableKm} km），自動取消導航`
      : '導航目標已不存在，自動取消導航');
    s.navigationView = rules.computeNavigation(s, STATIONS, haversineKm);
  }

  _ecallFaulted() {
    const ecall = this.state.devices.find((d) => d.type === 'ecall');
    return !ecall || ecall.fault;
  }

  /** Dashcam on the struck side first, then any healthy dashcam. */
  _pickUploadSource(direction) {
    const cams = this.state.devices.filter((d) => d.type === 'dashcam' && !d.fault);
    return cams.find((d) => d.props.position === direction) || cams[0] || null;
  }

  /** The current upload source is gone (deleted or faulted): restart the upload on another dashcam. */
  _reassignUploadSource(reason) {
    const inc = this.state.incident;
    const next = this._pickUploadSource(inc.direction);
    inc.uploadSource = next ? next.id : null;
    inc.uploadProgress = 0;
    this._log('rule', next ? `${reason}，改由「${next.name}」重新上傳影像` : `${reason}，已無可用的行車記錄器`);
  }

  /** Start dialling the selected service; connects immediately when ecallConnectS is 0. */
  _startCall() {
    const inc = this.state.incident;
    inc.ecallState = 'CALLING';
    inc.callStartedAt = this.state.simTime;
    this._log('event', `eCall 撥打 ${rules.ECALL_SERVICE_LABEL[inc.ecallService]}`);
    if (this.state.settings.ecallConnectS <= 0) this._connectCall();
  }

  /** Connected: transmit GPS position and impact direction. */
  _connectCall() {
    const inc = this.state.incident;
    const pos = this.state.environment.position;
    inc.ecallState = 'CONNECTED';
    inc.connectedAt = this.state.simTime;
    this._log('event', `eCall 已連線 ${rules.ECALL_SERVICE_LABEL[inc.ecallService]}：已傳送 GPS 座標（${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}）與撞擊方向（${rules.DIRECTION_LABEL[inc.direction]}）、衝擊 ${inc.impactG} g`);
  }

  // ---------------------------------------------------------------- actions
  dispatch(action) {
    assert(action && typeof action.type === 'string', '缺少 action type');
    const actions = this.actions;
    assert(own(actions, action.type), `未知的操作：${action.type}`);
    actions[action.type].call(this, action);
    if (!['tick', 'reset', 'factoryReset', 'scenario'].includes(action.type)) this.evaluate();
    return this.publicState();
  }

  get actions() {
    return {
      // Behavior 1
      impact(a) {
        const g = num(a.g, '衝擊值 g', { min: 0, max: 100 });
        const direction = a.direction ?? 'front';
        assert(direction === 'front' || direction === 'rear', '撞擊方向必須是 front 或 rear');
        const dirLabel = rules.DIRECTION_LABEL[direction];
        const st = this.state.settings;
        const inc = this.state.incident;
        // The impact is reported by a collision sensor covering the struck side (a sensor without a
        // position covers both). With no healthy sensor on that side nothing reports the impact.
        const sensors = this.state.devices.filter((d) => d.type === 'g_sensor' && (!d.props.position || d.props.position === direction));
        if (!sensors.some((d) => !d.fault)) {
          this._log('event', sensors.length
            ? `${dirLabel}碰撞傳感器故障，${dirLabel}撞擊 ${g} g 未被偵測`
            : `${dirLabel}未配置碰撞傳感器，${dirLabel}撞擊 ${g} g 未被偵測`);
          return;
        }
        if (g < st.impactThresholdG) {
          this._log('event', `偵測到${dirLabel}輕微碰撞 ${g} g（低於閾值 ${st.impactThresholdG} g，不觸發事故流程）`);
          return;
        }
        if (inc.active) {
          this._log('event', `事故進行中再次偵測到${dirLabel}衝擊 ${g} g（已記錄）`);
          return;
        }
        const source = this._pickUploadSource(direction);
        // A scenario resets the clock, so startedAt does not identify an incident; this counter does
        // (it lives on the engine and is not part of the log, so exports stay reproducible).
        this._incidentSeq = (this._incidentSeq || 0) + 1;
        Object.assign(inc, {
          id: this._incidentSeq,
          active: true,
          direction,
          impactG: g,
          startedAt: this.state.simTime,
          ecallState: this._ecallFaulted() ? 'FAULT' : 'COUNTDOWN',
          faultAcknowledged: false,
          ecallService: null,
          ecallRemainingS: st.ecallCountdownS,
          callStartedAt: null,
          connectedAt: null,
          uploadSource: source ? source.id : null,
          uploadProgress: 0,
          uploadDone: false,
        });
        // The system-level transition (-> CRITICAL_EMERGENCY) is logged by _logChanges().
        this._log('event', `${dirLabel}碰撞傳感器回報 ${g} g ≥ ${st.impactThresholdG} g：啟動事故流程（碰撞方位：${dirLabel}）`);
        if (source && source.props.position === direction) this._log('rule', `受撞擊側（${dirLabel}）記錄器「${source.name}」優先上傳影像，其餘記錄器進入 EMERGENCY_LOCK`);
        if (source && source.props.position !== direction) this._log('rule', `${dirLabel}記錄器無法使用，改由「${source.name}」上傳影像`);
        if (!source) this._log('rule', '沒有可用的行車記錄器，無法上傳影像');
        this._log('rule', '緊急電力保留：卸載所有 P2／P3 設備與音響');
        if (inc.ecallState === 'FAULT') {
          this._log('rule', `${this.state.devices.some((d) => d.type === 'ecall') ? 'eCall 模組故障' : '未配置 eCall 模組'}，無法自動通報：請手動撥打 119（救護）或 110（警政）`);
        } else if (inc.ecallState === 'COUNTDOWN' && st.ecallCountdownS <= 0) {
          inc.ecallService = 'both';
          this._log('rule', `eCall 倒數設為 0 秒：立即撥打 ${rules.ECALL_SERVICE_LABEL.both}`);
          this._startCall();
        } else if (inc.ecallState === 'COUNTDOWN') {
          this._log('rule', `eCall ${st.ecallCountdownS} 秒倒數開始：可選擇撥打 119（救護）或 110（警政），或取消通報`);
        }
      },
      selectEcall(a) {
        const inc = this.state.incident;
        assert(inc.active, '目前沒有事故');
        assert(inc.ecallState !== 'FAULT', 'eCall 模組故障，自動通報已中斷，請手動撥打 119 或 110');
        assert(inc.ecallState === 'COUNTDOWN', '只有在倒數期間可以選擇撥打對象');
        const service = String(a.service);
        assert(service === '119' || service === '110', 'service 必須是 119 或 110');
        inc.ecallService = service;
        inc.ecallRemainingS = 0;
        this._log('event', `駕駛選擇撥打 ${rules.ECALL_SERVICE_LABEL[service]}`);
        this._startCall();
      },
      cancelEcall() {
        const inc = this.state.incident;
        assert(inc.active, '目前沒有事故');
        assert(inc.ecallState === 'COUNTDOWN', '只有在倒數期間可以取消通報');
        inc.ecallState = 'CANCELLED';
        this._log('event', '駕駛按下「我沒事，取消通報」');
      },
      ackEcallFault() {
        const inc = this.state.incident;
        assert(inc.active && inc.ecallState === 'FAULT', '目前沒有中斷的 eCall 通報');
        assert(!inc.faultAcknowledged, '已確認過 eCall 故障');
        inc.faultAcknowledged = true;
        this._log('event', '駕駛確認 eCall 故障，將自行撥打 119 或 110（蜂鳴器停止）');
      },
      clearIncident() {
        assert(this.state.incident.active, '目前沒有事故');
        this.state.incident = this._idleIncident();
        this._log('event', '解除事故：設備恢復事故前設定');
      },
      // Behavior 2
      siren(a) {
        const active = bool(a.active, 'active');
        const direction = a.direction ?? this.state.sensors.siren.direction;
        assert(own(rules.DIRECTION_LABEL, direction), '方位必須是 front / rear / left / right');
        this.state.sensors.siren = { active, direction };
        const dir = rules.DIRECTION_LABEL[direction];
        if (!active) {
          this._log('event', '救護車笛聲結束');
          return;
        }
        // The siren is part of the environment; it only takes effect once an audio sensor hears it
        // (a sensor repaired while the siren is still sounding picks it up on the next evaluation).
        const sensors = this.state.devices.filter((d) => d.type === 'audio_sensor');
        if (sensors.some((d) => !d.fault)) this._log('event', `音訊傳感器偵測到緊急車輛笛聲，解析方位：${dir}`);
        else this._log('event', `${dir}出現救護車笛聲，但${sensors.length ? '音訊傳感器故障' : '未配置音訊傳感器'}，未被偵測`);
      },
      // Behavior 3
      blindSpot(a) {
        assert(a.side === 'left' || a.side === 'right', 'side 必須是 left 或 right');
        this.state.sensors.blindSpot[a.side] = bool(a.detected, 'detected');
        this._log('event', `${a.side === 'left' ? '左' : '右'}側盲區：${a.detected ? '偵測到來車' : '淨空'}`);
      },
      turnSignal(a) {
        assert(['off', 'left', 'right'].includes(a.value), '方向燈必須是 off / left / right');
        this.state.sensors.turnSignal = a.value;
        this._log('event', `方向燈：${{ off: '關閉', left: '左轉', right: '右轉' }[a.value]}`);
      },
      // Behavior 4
      setRange(a) {
        const km = num(a.km, '剩餘里程', { min: 0, max: 1500 });
        const st = this.state.settings;
        this.state.environment.rangeKm = km;
        if (km <= st.lowRangeKm) this.state.lowRange.active = true;
        else if (km > st.lowRangeClearKm) this.state.lowRange.active = false;
        // The range is part of the vehicle state; the system only learns it through a working ECU
        // (one repaired or added later picks up the current range on the next evaluation).
        const ecus = this.state.devices.filter((d) => d.type === 'ecu');
        if (ecus.some((d) => !d.fault)) this._log('event', `行車電腦回報剩餘里程 ${km} km`);
        else this._log('event', `剩餘里程變為 ${km} km，但${ecus.length ? '行車電腦故障' : '未配置行車電腦'}，系統無法取得里程`);
      },
      navigate(a) {
        const view = rules.computeNavigation(this.state, STATIONS, haversineKm);
        const st = view.stations.find((x) => x.id === a.stationId);
        assert(st, '找不到加油站');
        assert(rules.ecuAvailable(this.state), '里程資訊無法取得（行車電腦故障或未配置），無法判斷加油站是否可抵達');
        assert(st.reachable, '此加油站超出可抵達範圍');
        this.state.navigation.targetId = st.id;
        this._log('event', `設定導航：${st.name}（${st.distanceKm} km）`);
      },
      cancelNavigation() {
        const id = this.state.navigation.targetId;
        assert(id, '目前沒有導航目標');
        const st = STATIONS.find((x) => x.id === id);
        this.state.navigation.targetId = null;
        this._log('event', `取消導航：${st ? st.name : id}`);
      },
      // Behavior 5
      setCapacity(a) {
        this.state.settings.capacityW = num(a.watts, '電力容量', { min: 0, max: 10000 });
        this._log('event', `發電機容量設定為 ${this.state.settings.capacityW} W`);
      },
      setAlternatorFault(a) {
        this.state.power.alternatorFault = bool(a.fault, 'fault');
        this._log('event', a.fault ? `發電機故障：改由電瓶供電（${this.state.settings.batteryW} W）` : '發電機恢復正常');
      },
      // Behavior 6
      setAmbient(a) {
        const t = num(a.celsius, '車外溫度', { min: -20, max: 45 });
        const st = this.state.settings;
        this.state.environment.ambientTempC = t;
        // Hysteresis: defrost on at <= defrostOnC, off only above defrostOffC. Only an auto-mode
        // defroster follows it (a manually overridden one is left alone); the automatic switching
        // is logged by _logChanges(), also when a repaired defroster catches up with the rule.
        if (t <= st.defrostOnC) this.state.climate.defrostActive = true;
        else if (t > st.defrostOffC) this.state.climate.defrostActive = false;
        this._log('event', `車外溫度變為 ${t} °C`);
      },
      // devices
      setDevice(a) {
        const d = this.device(a.id);
        const t = getType(d.type);
        assert(t.userControl, `${d.name} 無法手動操作`);
        // Validate every field before changing anything: a rejected request leaves the device as it was.
        const on = a.on === undefined ? undefined : bool(a.on, 'on');
        if (a.level !== undefined) assert(t.adjustable, `${d.name} 沒有檔位`);
        const level = a.level === undefined ? undefined : num(a.level, '檔位', { min: t.minLevel, max: t.maxLevel, integer: true });
        if (a.load !== undefined) assert(t.variableLoad, `${d.name} 沒有可調整的負載`);
        const load = a.load === undefined ? undefined : num(a.load, '負載', { min: 0, max: t.maxLoad });
        if (a.auto !== undefined) assert(t.auto, `${d.name} 沒有自動模式`);
        const auto = a.auto === undefined ? undefined : bool(a.auto, 'auto');
        assert([on, level, load, auto].some((v) => v !== undefined), '沒有要變更的項目');
        const changes = [];
        if (on !== undefined) {
          if (on && !d.on) d.poweredSinceOn = false;
          d.on = on;
          if (t.auto) d.auto = false;
          changes.push(on ? '開啟' : '關閉');
        }
        if (level !== undefined) {
          d.level = level;
          if (t.auto) d.auto = false;
          changes.push(`檔位 ${d.level}`);
        }
        if (load !== undefined) {
          d.load = load;
          changes.push(`負載 ${d.load} W`);
        }
        if (auto !== undefined) {
          d.auto = auto;
          changes.push(d.auto ? '自動模式' : '手動模式');
        }
        this._log('event', `使用者操作 ${d.name}：${changes.join('、')}`);
      },
      setFault(a) {
        const d = this.device(a.id);
        d.fault = bool(a.fault, 'fault');
        this._log('event', `${d.name}：${d.fault ? '注入故障' : '故障排除'}`);
      },
      // clock / system
      clock(a) {
        if (a.command === 'pause') this.state.clockRunning = false;
        else if (a.command === 'resume') this.state.clockRunning = true;
        else if (a.command === 'step') {
          const sec = num(a.seconds ?? 1, '秒數', { min: 1, max: 600 });
          this.tick(sec);
          return;
        } else throw new ValidationError('clock command 必須是 pause / resume / step');
        this._log('system', this.state.clockRunning ? '模擬時鐘：繼續' : '模擬時鐘：暫停');
      },
      tick(a) {
        this.tick(num(a.seconds ?? 1, '秒數', { min: 1, max: 600 }));
      },
      reset() { this.reset(); },
      factoryReset() { this.factoryReset(); },
      scenario(a) { this.loadScenario(a.name); },
    };
  }

  // ---------------------------------------------------------------- scenarios
  loadScenario(name) {
    assert(own(SCENARIOS, name), `未知的情境：${name}`);
    const sc = SCENARIOS[name];
    this.reset();
    this._log('system', `載入情境：${sc.label}`);
    for (const action of sc.actions) {
      this.actions[action.type].call(this, action);
      this.evaluate();
    }
  }

  // ---------------------------------------------------------------- configuration (CRUD)
  getConfig() {
    return {
      settings: this.config.settings,
      zones: this.config.zones,
      devices: this.config.devices,
      deviceTypes: Object.fromEntries(Object.entries(DEVICE_TYPES).map(([k, v]) => [k, {
        label: v.label, fixedPriority: v.fixedPriority, defaultPriority: v.defaultPriority, ratedW: v.ratedW ?? 0,
        adjustable: !!v.adjustable, userControl: !!v.userControl, props: v.props || [],
      }])),
    };
  }

  addZone({ id, name }) {
    assert(typeof id === 'string' && /^[a-z0-9_-]{1,32}$/.test(id), '區域 ID 只能包含小寫英數、- 或 _');
    assert(!RESERVED_ID(id), `區域 ID 不可使用保留字：${id}`);
    assert(typeof name === 'string' && name.trim(), '區域名稱不可空白');
    assert(!this.config.zones.some((z) => z.id === id), `區域 ID 已存在：${id}`);
    this.config.zones.push({ id, name: name.trim() });
    this._log('config', `新增區域：${name.trim()}`);
    this.evaluate();
  }

  updateZone(id, { name }) {
    const z = this.config.zones.find((x) => x.id === id);
    assert(z, `找不到區域：${id}`);
    assert(typeof name === 'string' && name.trim(), '區域名稱不可空白');
    z.name = name.trim();
    this._log('config', `區域 ${id} 改名為：${z.name}`);
    this.evaluate();
  }

  deleteZone(id) {
    const idx = this.config.zones.findIndex((x) => x.id === id);
    assert(idx >= 0, `找不到區域：${id}`);
    assert(!this.config.devices.some((d) => d.zone === id), '區域內仍有設備，請先移除或移動設備');
    const [z] = this.config.zones.splice(idx, 1);
    this._log('config', `刪除區域：${z.name}`);
    this.evaluate();
  }

  _validateDeviceFields(input, typeKey, isNew) {
    const t = getType(typeKey);
    const out = {};
    if (input.name !== undefined || isNew) {
      assert(typeof input.name === 'string' && input.name.trim(), '設備名稱不可空白');
      out.name = input.name.trim();
    }
    if (input.zone !== undefined || isNew) {
      assert(this.config.zones.some((z) => z.id === input.zone), `找不到區域：${input.zone}`);
      out.zone = input.zone;
    }
    if (input.priority !== undefined && input.priority !== null && input.priority !== '') {
      const p = num(input.priority, '優先等級', { min: 0, max: 3, integer: true });
      if (t.fixedPriority === 0) assert(p === 0, '安全設備固定為 P0');
      else assert(p >= 1, '非安全設備的優先等級必須是 P1–P3');
      out.priority = p;
    }
    if (input.shedOrder !== undefined && input.shedOrder !== '') out.shedOrder = num(input.shedOrder, '卸載順序', { min: 0, max: 999 });
    if (input.ratedW !== undefined && input.ratedW !== '') out.ratedW = num(input.ratedW, '額定功率', { min: 0, max: 2000 });
    if (t.props && (input.props || isNew)) {
      out.props = {};
      for (const p of t.props) {
        const v = input.props?.[p];
        if (p === 'side') assert(v === 'left' || v === 'right', '後視鏡與盲區雷達必須指定 side（left / right）');
        if (p === 'position') assert(v === 'front' || v === 'rear', '記錄器與碰撞傳感器必須指定 position（front / rear）');
        out.props[p] = v;
      }
    }
    return out;
  }

  addDevice(input) {
    assert(input && own(DEVICE_TYPES, input.type), '設備類型無效');
    assert(typeof input.id === 'string' && /^[a-z0-9_-]{1,32}$/.test(input.id), '設備 ID 只能包含小寫英數、- 或 _');
    assert(!RESERVED_ID(input.id), `設備 ID 不可使用保留字：${input.id}`);
    assert(!this.config.devices.some((d) => d.id === input.id), `設備 ID 已存在：${input.id}`);
    const fields = this._validateDeviceFields(input, input.type, true);
    const cfg = this._normaliseDeviceConfig({ id: input.id, type: input.type, ...fields });
    this.config.devices.push(cfg);
    this.state.devices.push(this._createRuntimeDevice(cfg));
    this._log('config', `新增設備：${cfg.name}（${cfg.type}, P${cfg.priority}）`);
    this.evaluate();
    return cfg;
  }

  updateDevice(id, input) {
    const cfg = this.config.devices.find((d) => d.id === id);
    assert(cfg, `找不到設備：${id}`);
    const fields = this._validateDeviceFields(input || {}, cfg.type, false);
    Object.assign(cfg, fields);
    const rt = this.device(id);
    for (const k of ['name', 'zone', 'priority', 'shedOrder', 'ratedW']) if (k in fields) rt[k] = fields[k];
    if (fields.props) rt.props = { ...fields.props };
    this._log('config', `修改設備：${cfg.name}`);
    this.evaluate();
    return cfg;
  }

  deleteDevice(id) {
    const idx = this.config.devices.findIndex((d) => d.id === id);
    assert(idx >= 0, `找不到設備：${id}`);
    const [cfg] = this.config.devices.splice(idx, 1);
    this.state.devices = this.state.devices.filter((d) => d.id !== id);
    this._log('config', `刪除設備：${cfg.name}`);
    const inc = this.state.incident;
    if (inc.uploadSource === id) {
      if (inc.uploadProgress >= 100) {
        // Evidence already uploaded: nothing to redo, keep the completed state.
        inc.uploadSource = null;
        inc.uploadDone = true;
        this._log('rule', `「${cfg.name}」已移除，影像已完成雲端存證，不需重傳`);
      } else {
        this._reassignUploadSource(`「${cfg.name}」已移除`);
      }
    }
    this.evaluate();
  }

  updateSettings(input) {
    assert(input && typeof input === 'object' && !Array.isArray(input), '設定格式錯誤');
    const s = { ...this.config.settings };
    for (const [k, v] of Object.entries(input)) {
      assert(own(s, k), `未知的設定：${k}`);
      const range = own(SETTING_RANGES, k) ? SETTING_RANGES[k] : { label: k, min: 0, max: 100000 };
      s[k] = num(v, range.label, range);
    }
    assert(s.lowRangeClearKm > s.lowRangeKm, '解除里程必須大於警示里程');
    assert(s.criticalRangeKm <= s.lowRangeKm, '極低里程門檻不可大於低里程門檻');
    assert(s.defrostOffC > s.defrostOnC, '除霧關閉溫度必須高於開啟溫度');
    // Only values that actually change are applied to the running state, so saving the configuration
    // page (which always sends every field) does not undo a capacity the TA set from the console.
    const changed = Object.keys(s).filter((k) => s[k] !== this.config.settings[k]);
    Object.assign(this.config.settings, s);
    for (const k of changed) this.state.settings[k] = s[k];
    // Re-apply the hysteresis rules to the new thresholds.
    const st = this.state.settings;
    const env = this.state.environment;
    if (env.rangeKm <= st.lowRangeKm) this.state.lowRange.active = true;
    else if (env.rangeKm > st.lowRangeClearKm) this.state.lowRange.active = false;
    if (env.ambientTempC <= st.defrostOnC) this.state.climate.defrostActive = true;
    else if (env.ambientTempC > st.defrostOffC) this.state.climate.defrostActive = false;
    const label = (k) => (own(SETTING_RANGES, k) ? SETTING_RANGES[k].label : k);
    this._log('config', changed.length ? `更新系統設定：${changed.map((k) => `${label(k)} ${s[k]}`).join('、')}` : '更新系統設定（沒有變更）');
    this.evaluate();
  }

  // ---------------------------------------------------------------- log export
  /** The full retained log (oldest first), so the TA can compare runs. */
  exportLog() {
    return {
      simTime: this.state.simTime,
      systemLevel: this.state.systemLevel,
      entries: this.state.log.map((l) => ({ ...l, time: fmtSimTime(l.t) })),
    };
  }

  exportLogCsv() {
    // Guard against spreadsheet formula injection (device and zone names are user-editable).
    const cell = (v) => {
      let text = String(v);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const rows = ['seq,t,time,kind,message'];
    for (const l of this.state.log) rows.push([l.seq, l.t, cell(fmtSimTime(l.t)), cell(l.kind), cell(l.message)].join(','));
    return `\uFEFF${rows.join('\r\n')}\r\n`;
  }

  // ---------------------------------------------------------------- view
  publicState() {
    const s = this.state;
    return {
      bootId: this._bootId,
      rev: this._rev || 0,
      simTime: s.simTime,
      clockRunning: s.clockRunning,
      settings: s.settings,
      environment: s.environment,
      climate: s.climate,
      power: s.power,
      sensors: s.sensors,
      incident: s.incident,
      lowRange: s.lowRange,
      navigation: s.navigationView,
      alerts: s.alerts,
      mainAlert: s.mainAlert,
      buzzer: s.buzzer,
      systemLevel: s.systemLevel,
      vehicleParts: s.vehicleParts,
      zones: this.config.zones.map((z) => ({
        ...z,
        status: s.zoneStatus[z.id] || 'STANDBY',
        drawW: s.devices.filter((d) => d.zone === z.id).reduce((acc, d) => acc + d.drawW, 0),
      })),
      devices: s.devices.map((d) => ({ ...d, typeLabel: DEVICE_TYPES[d.type].label, userControl: !!DEVICE_TYPES[d.type].userControl, adjustable: !!DEVICE_TYPES[d.type].adjustable, minLevel: DEVICE_TYPES[d.type].minLevel, maxLevel: DEVICE_TYPES[d.type].maxLevel, hasAuto: !!DEVICE_TYPES[d.type].auto, variableLoad: !!DEVICE_TYPES[d.type].variableLoad })),
      log: s.log.slice(-200),
      logTotal: s.log.length,
      scenarios: Object.entries(SCENARIOS).map(([id, v]) => ({ id, label: v.label, description: v.description })),
    };
  }
}

// ------------------------------------------------------------------ scenarios
const SCENARIOS = {
  'winter-overload': {
    label: '寒流夜間長途（電力超載）',
    description: '車外 −6 °C，三個座椅加熱 3 檔、逆變器 200 W、兩台後座螢幕、音響 5 檔 → 需求 1296 W（負載率 129.6%），卸載 P3 後降為 966 W',
    actions: [
      { type: 'setAmbient', celsius: -6 },
      { type: 'setDevice', id: 'seat-driver', on: true, level: 3 },
      { type: 'setDevice', id: 'seat-passenger', on: true, level: 3 },
      { type: 'setDevice', id: 'seat-rear', on: true, level: 3 },
      { type: 'setDevice', id: 'screen-rear-left', on: true },
      { type: 'setDevice', id: 'screen-rear-right', on: true },
      { type: 'setDevice', id: 'inverter', on: true, load: 200 },
    ],
  },
  'alternator-fault': {
    label: '寒流＋發電機故障（容量 400 W）',
    description: '承上情境，發電機故障 → 座椅加熱全數卸載、空調降至 2 檔',
    actions: [
      { type: 'setAmbient', celsius: -6 },
      { type: 'setDevice', id: 'seat-driver', on: true, level: 3 },
      { type: 'setDevice', id: 'seat-passenger', on: true, level: 3 },
      { type: 'setDevice', id: 'seat-rear', on: true, level: 3 },
      { type: 'setDevice', id: 'screen-rear-left', on: true },
      { type: 'setDevice', id: 'screen-rear-right', on: true },
      { type: 'setDevice', id: 'inverter', on: true, load: 200 },
      { type: 'setAlternatorFault', fault: true },
    ],
  },
  'critical-power': {
    label: '電力危急（容量 200 W）',
    description: '車外 −6 °C，容量設為 200 W → 安全設備＋空調 1 檔＋除霧仍超過容量',
    actions: [
      { type: 'setAmbient', celsius: -6 },
      { type: 'setCapacity', watts: 200 },
    ],
  },
  collision: {
    label: '前方撞擊（6.0 g）',
    description: '一般行駛中發生 6.0 g 前方撞擊，音響與左後座螢幕運作中 → 前記錄器優先上傳',
    actions: [
      { type: 'setDevice', id: 'screen-rear-left', on: true },
      { type: 'impact', g: 6, direction: 'front' },
    ],
  },
  'collision-rear': {
    label: '後方追撞（5.5 g）',
    description: '停等紅燈時遭後方追撞 5.5 g，座椅加熱運作中 → 後記錄器優先上傳、P2/P3 卸載',
    actions: [
      { type: 'setDevice', id: 'seat-driver', on: true, level: 2 },
      { type: 'impact', g: 5.5, direction: 'rear' },
    ],
  },
  'siren-rear': {
    label: '後方救護車接近',
    description: '音響 5 檔播放中，後方出現救護車',
    actions: [{ type: 'siren', active: true, direction: 'rear' }],
  },
  'blind-spot-left': {
    label: '左側盲區有車＋打左方向燈',
    description: '左側盲區偵測到來車，駕駛打左方向燈',
    actions: [
      { type: 'blindSpot', side: 'left', detected: true },
      { type: 'turnSignal', value: 'left' },
    ],
  },
  'low-range': {
    label: '剩餘里程 25 km',
    description: '剩餘里程 25 km → 可抵達距離 22.5 km 內的加油站',
    actions: [{ type: 'setRange', km: 25 }],
  },
};

module.exports = { Engine, ValidationError, SCENARIOS };
