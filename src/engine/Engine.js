'use strict';

const { EventEmitter } = require('events');
const { DEVICE_TYPES, getType } = require('./deviceTypes');
const { allocatePower } = require('./powerManager');
const rules = require('./rules');
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
const LOG_LIMIT = 300;

function assert(cond, message) {
  if (!cond) throw new ValidationError(message);
}

function num(value, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  assert(value !== '' && value !== null && value !== undefined && Number.isFinite(n), `${name} 必須是數字`);
  assert(n >= min && n <= max, `${name} 必須介於 ${min} 與 ${max} 之間`);
  return n;
}

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
      active: false, direction: null, impactG: null, startedAt: null,
      ecallState: 'STANDBY', ecallService: null, ecallRemainingS: null, callStartedAt: null, connectedAt: null,
      uploadSource: null, uploadProgress: 0,
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
      mode: 'OFF', status: 'OFF', effectiveLevel: c.initial.level, drawW: 0, powerState: 'NORMAL', powerReason: null,
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
    rules.applyClimate(s);
    for (const d of s.devices) d.mode = rules.deriveMode(d, s);
    const power = allocatePower(s.devices, {
      capacityW: this.capacityW(),
      highLoadPct: s.settings.highLoadPct,
      emergency: s.incident.active,
    });
    s.power = { ...s.power, ...power };
    s.navigationView = rules.computeNavigation(s, STATIONS, haversineKm);
    s.alerts = rules.computeAlerts(s, power);
    s.mainAlert = s.alerts[0] || null;
    s.buzzer = s.alerts.some((a) => a.id === 'collision' || a.id.startsWith('blindspot-'));
    for (const d of s.devices) {
      if (d.type === 'display' && !d.fault) {
        d.mode = !s.mainAlert ? 'NORMAL' : s.mainAlert.level === 'critical' ? 'EMERGENCY' : s.mainAlert.level === 'warning' ? 'WARNING' : 'NORMAL';
      }
      d.status = rules.deriveStatus(d);
    }
    this._logChanges();
    this.emit('change');
  }

  _snapshot() {
    const s = this.state;
    const devices = {};
    for (const d of s.devices) devices[d.id] = { mode: d.mode, powerState: d.powerState, effectiveLevel: d.effectiveLevel, level: d.level, auto: d.auto, drawW: d.drawW, name: d.name };
    return { devices, powerStatus: s.power.status, alerts: s.alerts.map((a) => a.id + '|' + a.title) };
  }

  _logChanges() {
    const now = this._snapshot();
    const prev = this._prevSnapshot;
    this._prevSnapshot = now;
    if (!prev) return;
    for (const [id, d] of Object.entries(now.devices)) {
      const p = prev.devices[id];
      if (!p) continue;
      if (p.mode !== d.mode) this._log('device', `${d.name}：${p.mode} → ${d.mode}`);
      // Behavior 6: a level chosen by the climate rule (auto mode) is logged so the TA can trace it.
      if (d.auto && p.auto && p.level !== d.level) this._log('rule', `${d.name}：自動依溫差調節 ${p.level} → ${d.level} 檔（${p.drawW} → ${d.drawW} W）`);
      if (p.powerState !== d.powerState || p.effectiveLevel !== d.effectiveLevel) {
        if (p.powerState !== d.powerState || d.powerState === 'REDUCED') {
          const lvl = d.powerState === 'REDUCED' ? `（檔位 ${d.effectiveLevel}）` : '';
          this._log('power', `${d.name}：供電 ${p.powerState} → ${d.powerState}${lvl}`);
        }
      }
    }
    if (prev.powerStatus !== now.powerStatus) this._log('power', `電力狀態：${prev.powerStatus} → ${now.powerStatus}`);
    const added = now.alerts.filter((a) => !prev.alerts.includes(a));
    const removedIds = prev.alerts.map((a) => a.split('|')[0]).filter((id) => !now.alerts.some((a) => a.startsWith(id + '|')));
    for (const a of added) this._log('alert', `警示：${a.split('|')[1]}`);
    for (const id of removedIds) this._log('alert', `警示解除：${id}`);
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
      if (src && !src.fault) inc.uploadProgress = Math.min(100, inc.uploadProgress + 100 / st.uploadDurationS);
    }
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
    const handler = this.actions[action.type];
    assert(handler, `未知的操作：${action.type}`);
    handler.call(this, action);
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
        // The impact is reported by the collision sensor on the struck side; if every sensor on
        // that side is faulted the impact is not detected.
        const sensors = this.state.devices.filter((d) => d.type === 'g_sensor' && d.props.position === direction);
        if (sensors.length && sensors.every((d) => d.fault)) {
          this._log('event', `${dirLabel}碰撞傳感器故障，${dirLabel}撞擊 ${g} g 未被偵測`);
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
        const ecall = this.state.devices.find((d) => d.type === 'ecall');
        // The dashcam on the struck side uploads first; fall back to any healthy dashcam.
        const sameSide = this.state.devices.find((d) => d.type === 'dashcam' && d.props.position === direction && !d.fault);
        const anyCam = this.state.devices.find((d) => d.type === 'dashcam' && !d.fault);
        const source = sameSide || anyCam || null;
        Object.assign(inc, {
          active: true,
          direction,
          impactG: g,
          startedAt: this.state.simTime,
          ecallState: !ecall || ecall.fault ? 'FAULT' : 'COUNTDOWN',
          ecallService: null,
          ecallRemainingS: st.ecallCountdownS,
          callStartedAt: null,
          connectedAt: null,
          uploadSource: source ? source.id : null,
          uploadProgress: 0,
        });
        this._log('event', `${dirLabel}撞擊 ${g} g ≥ ${st.impactThresholdG} g：系統等級升為 CRITICAL_EMERGENCY（碰撞方向：${dirLabel}）`);
        if (source && source.props.position === direction) this._log('rule', `受撞擊側（${dirLabel}）記錄器「${source.name}」優先上傳影像，其餘記錄器進入 EMERGENCY_LOCK`);
        if (source && source.props.position !== direction) this._log('rule', `${dirLabel}記錄器無法使用，改由「${source.name}」上傳影像`);
        if (!source) this._log('rule', '沒有可用的行車記錄器，無法上傳影像');
        if (inc.ecallState === 'COUNTDOWN') this._log('rule', `eCall ${st.ecallCountdownS} 秒倒數開始：可選擇撥打 119（救護）或 110（警政），或取消通報`);
        this._log('rule', '緊急電力保留：卸載所有 P2／P3 設備與音響');
      },
      selectEcall(a) {
        const inc = this.state.incident;
        assert(inc.active, '目前沒有事故');
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
      clearIncident() {
        assert(this.state.incident.active, '目前沒有事故');
        this.state.incident = this._idleIncident();
        this._log('event', '解除事故：設備恢復事故前設定');
      },
      // Behavior 2
      siren(a) {
        const active = !!a.active;
        const direction = a.direction ?? this.state.sensors.siren.direction;
        assert(rules.DIRECTION_LABEL[direction], '方位必須是 front / rear / left / right');
        this.state.sensors.siren = { active, direction };
        this._log('event', active ? `偵測到救護車笛聲（${rules.DIRECTION_LABEL[direction]}）` : '救護車笛聲結束');
      },
      // Behavior 3
      blindSpot(a) {
        assert(a.side === 'left' || a.side === 'right', 'side 必須是 left 或 right');
        this.state.sensors.blindSpot[a.side] = !!a.detected;
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
        this._log('event', `行車電腦回報剩餘里程 ${km} km`);
      },
      navigate(a) {
        const view = rules.computeNavigation(this.state, STATIONS, haversineKm);
        const st = view.stations.find((x) => x.id === a.stationId);
        assert(st, '找不到加油站');
        assert(st.reachable, '此加油站超出可抵達範圍');
        this.state.navigation.targetId = st.id;
        this._log('event', `設定導航：${st.name}（${st.distanceKm} km）`);
      },
      // Behavior 5
      setCapacity(a) {
        this.state.settings.capacityW = num(a.watts, '電力容量', { min: 0, max: 10000 });
        this._log('event', `發電機容量設定為 ${this.state.settings.capacityW} W`);
      },
      setAlternatorFault(a) {
        this.state.power.alternatorFault = !!a.fault;
        this._log('event', a.fault ? `發電機故障：改由電瓶供電（${this.state.settings.batteryW} W）` : '發電機恢復正常');
      },
      // Behavior 6
      setAmbient(a) {
        const t = num(a.celsius, '車外溫度', { min: -20, max: 45 });
        const st = this.state.settings;
        const was = this.state.climate.defrostActive;
        this.state.environment.ambientTempC = t;
        if (t <= st.defrostOnC) this.state.climate.defrostActive = true;
        else if (t > st.defrostOffC) this.state.climate.defrostActive = false;
        this._log('event', `車外溫度變為 ${t} °C`);
        if (!was && this.state.climate.defrostActive) this._log('rule', `車外 ${t} °C ≤ ${st.defrostOnC} °C：自動開啟後擋風除霧`);
        if (was && !this.state.climate.defrostActive) this._log('rule', `車外 ${t} °C > ${st.defrostOffC} °C：自動關閉後擋風除霧`);
      },
      // devices
      setDevice(a) {
        const d = this.device(a.id);
        const t = getType(d.type);
        assert(t.userControl, `${d.name} 無法手動操作`);
        const changes = [];
        if (a.on !== undefined) {
          const on = !!a.on;
          if (on && !d.on) d.poweredSinceOn = false;
          d.on = on;
          if (t.auto) d.auto = false;
          changes.push(on ? '開啟' : '關閉');
        }
        if (a.level !== undefined) {
          assert(t.adjustable, `${d.name} 沒有檔位`);
          d.level = num(a.level, '檔位', { min: t.minLevel, max: t.maxLevel });
          if (t.auto) d.auto = false;
          changes.push(`檔位 ${d.level}`);
        }
        if (a.load !== undefined) {
          assert(t.variableLoad, `${d.name} 沒有可調整的負載`);
          d.load = num(a.load, '負載', { min: 0, max: t.maxLoad });
          changes.push(`負載 ${d.load} W`);
        }
        if (a.auto !== undefined) {
          assert(t.auto, `${d.name} 沒有自動模式`);
          d.auto = !!a.auto;
          changes.push(d.auto ? '自動模式' : '手動模式');
        }
        this._log('event', `使用者操作 ${d.name}：${changes.join('、')}`);
      },
      setFault(a) {
        const d = this.device(a.id);
        d.fault = !!a.fault;
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
    const sc = SCENARIOS[name];
    assert(sc, `未知的情境：${name}`);
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
      const p = num(input.priority, '優先等級', { min: 0, max: 3 });
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
        if (p === 'side') assert(v === 'left' || v === 'right', '後視鏡必須指定 side（left / right）');
        if (p === 'position') assert(v === 'front' || v === 'rear', '記錄器與碰撞傳感器必須指定 position（front / rear）');
        out.props[p] = v;
      }
    }
    return out;
  }

  addDevice(input) {
    assert(input && typeof input.type === 'string' && DEVICE_TYPES[input.type], '設備類型無效');
    assert(typeof input.id === 'string' && /^[a-z0-9_-]{1,32}$/.test(input.id), '設備 ID 只能包含小寫英數、- 或 _');
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
    if (this.state.incident.uploadSource === id) this.state.incident.uploadSource = null;
    this._log('config', `刪除設備：${cfg.name}`);
    this.evaluate();
  }

  updateSettings(input) {
    const s = { ...this.config.settings };
    for (const [k, v] of Object.entries(input || {})) {
      assert(k in s, `未知的設定：${k}`);
      s[k] = num(v, k, { min: 0, max: 100000 });
    }
    assert(s.lowRangeClearKm > s.lowRangeKm, '解除里程必須大於警示里程');
    assert(s.defrostOffC > s.defrostOnC, '除霧關閉溫度必須高於開啟溫度');
    Object.assign(this.config.settings, s);
    Object.assign(this.state.settings, s);
    this._log('config', '更新系統設定');
    this.evaluate();
  }

  // ---------------------------------------------------------------- view
  publicState() {
    const s = this.state;
    return {
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
      zones: this.config.zones,
      devices: s.devices.map((d) => ({ ...d, typeLabel: DEVICE_TYPES[d.type].label, userControl: !!DEVICE_TYPES[d.type].userControl, adjustable: !!DEVICE_TYPES[d.type].adjustable, minLevel: DEVICE_TYPES[d.type].minLevel, maxLevel: DEVICE_TYPES[d.type].maxLevel, hasAuto: !!DEVICE_TYPES[d.type].auto, variableLoad: !!DEVICE_TYPES[d.type].variableLoad })),
      log: s.log.slice(-150),
      scenarios: Object.entries(SCENARIOS).map(([id, v]) => ({ id, label: v.label, description: v.description })),
    };
  }
}

// ------------------------------------------------------------------ scenarios
const SCENARIOS = {
  'winter-overload': {
    label: '寒流夜間長途（電力超載）',
    description: '車外 −6 °C，三個座椅加熱 3 檔、逆變器 200 W、兩台後座螢幕、音響 5 檔 → 需求 1288 W，卸載 P3 後降為 958 W',
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
    description: '一般行駛中發生 6.0 g 前方撞擊，音響與後座螢幕運作中 → 前記錄器優先上傳',
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
