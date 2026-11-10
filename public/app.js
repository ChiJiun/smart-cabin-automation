'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_LABEL = {
  NORMAL: '正常', WARNING: '警示', EMERGENCY: '緊急', STANDBY: '待機',
  SHED: '已卸載', DEFERRED: '延後啟動', FAULT: '故障',
};
const SYSTEM_LEVEL_LABEL = { NORMAL: '正常', WARNING: '警示', CRITICAL: '危急', CRITICAL_EMERGENCY: '緊急事故' };
const DIRECTION_LABEL = { front: '前方', rear: '後方', left: '左側', right: '右側' };
const ECALL_SERVICE_LABEL = { 119: '119（救護）', 110: '110（警政）', both: '119（救護）並通報 110（警政）' };
const POWER_LABEL = { NORMAL: '正常', HIGH_LOAD: '高負載', OVERLOAD: '超載・負載管理中', CRITICAL_POWER: '電力危急' };
const POWER_STATE_LABEL = { REDUCED: '降載', SHED: '已卸載', DEFERRED: '延後啟動' };
const REASON_LABEL = { OVERLOAD: '超載', EMERGENCY_RESERVE: '緊急電力保留' };
const ECALL_LABEL = { COUNTDOWN: '倒數中', CALLING: '撥號中', CONNECTED: '已連線', CANCELLED: '已取消', FAULT: '故障' };
const SIDE_SHORT = { left: '左', right: '右' };

let state = null;
let interacting = false;

// ------------------------------------------------------------------ API
async function act(action) {
  try {
    const res = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    render(body);
  } catch (err) {
    toast(err.message);
  }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'alert');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

// ------------------------------------------------------------------ render
function render(s) {
  state = s;
  renderHeader(s);
  renderCockpit(s);
  renderEcallWindow(s);
  renderPower(s);
  if (!interacting) renderZones(s);
  renderConsole(s);
  renderLog(s);
  updateSound(s);
}

const fmtTime = (t) => `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const fmtDuration = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
const pctText = (v) => (v === null || v === undefined ? '—' : `${v}%`);

function renderHeader(s) {
  $('#clockTime').textContent = fmtTime(s.simTime);
  $('#clockDot').classList.toggle('running', s.clockRunning);
  $('#clockToggle').textContent = s.clockRunning ? '暫停' : '繼續';
  // Only touch the live region when the level changes, so screen readers are not re-notified every tick.
  const lvl = $('#sysLevel');
  const text = `系統等級 ${s.systemLevel}（${SYSTEM_LEVEL_LABEL[s.systemLevel] || ''}）`;
  if (lvl.textContent !== text) {
    lvl.className = `badge syslevel ${s.systemLevel}`;
    lvl.textContent = text;
  }
}

function audioCardText(audio) {
  if (!audio) return '—';
  if (audio.fault) return '故障';
  if (audio.powerReason === 'EMERGENCY_RESERVE') return '緊急卸載';
  if (audio.status === 'SHED' || audio.status === 'DEFERRED') return STATUS_LABEL[audio.status];
  if (audio.mode === 'MUTED') return `🔇 靜音（保留音量 ${audio.level}）`;
  return audio.on ? '音量 ' + audio.level : '關閉';
}

function deviceOfType(s, type, pred = () => true) {
  return s.devices.find((d) => d.type === type && pred(d));
}

function ecallSummary(s) {
  const inc = s.incident;
  const service = ECALL_SERVICE_LABEL[inc.ecallService] || '';
  switch (inc.ecallState) {
    case 'COUNTDOWN': return `倒數 ${inc.ecallRemainingS} 秒（未選擇將自動撥打 119 並通報 110）`;
    case 'CALLING': return `撥號中：${service}`;
    case 'CONNECTED': return `已連線 ${service}・已傳送 GPS 座標與撞擊方向`;
    case 'CANCELLED': return '駕駛已取消通報';
    case 'FAULT': return 'eCall 故障，請手動撥打 119 或 110';
    default: return inc.ecallState;
  }
}

function renderCockpit(s) {
  const main = s.mainAlert;
  const flash = main && main.level === 'critical';
  let html = main
    ? `<div class="banner ${main.level} ${flash ? 'flash' : ''}" role="alert"><div class="title">${esc(main.title)}</div><div class="msg">${esc(main.message)}</div></div>`
    : `<div class="banner"><div class="title">行車狀態正常</div><div class="msg">所有系統運作中</div></div>`;

  const rest = s.alerts.slice(1);
  if (rest.length) {
    html += '<ul class="secondary">' + rest.map((a) => `<li><span class="badge ${a.level}">${a.level === 'critical' ? '緊急' : a.level === 'warning' ? '警示' : '提示'}</span><span><b>${esc(a.title)}</b>${a.message ? ' — ' + esc(a.message) : ''}</span></li>`).join('') + '</ul>';
  }

  const inc = s.incident;
  if (inc.active) {
    const upDev = inc.uploadSource ? s.devices.find((d) => d.id === inc.uploadSource) : null;
    const upName = upDev ? upDev.name : null;
    const struckSide = upDev && upDev.props && upDev.props.position === inc.direction;
    const dirLabel = DIRECTION_LABEL[inc.direction] || '';
    html += `<div class="incident">
      <div class="dir-tag">碰撞方位：${esc(dirLabel)}${inc.direction === 'front' ? '（前側）' : inc.direction === 'rear' ? '（後側）' : ''}・衝擊 ${inc.impactG} g</div>
      <div class="hint">影像雲端存證${upName ? `（${struckSide ? `受撞擊側 ${esc(upName)}` : `${esc(dirLabel)}記錄器無法使用，改由 ${esc(upName)}`}）` : ''}：${upName ? Math.round(inc.uploadProgress) + '%' : inc.uploadDone ? '100%（已完成，來源記錄器已移除）' : '無可用記錄器'}${upName ? '・其餘記錄器 EMERGENCY_LOCK 鎖定保存' : ''}</div>
      <div class="progress" role="progressbar" aria-label="影像上傳進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(upName || inc.uploadDone ? inc.uploadProgress : 0)}"><div style="width:${upName || inc.uploadDone ? inc.uploadProgress : 0}%"></div></div>
      <div class="ecall-line"><span><b>eCall</b>：${esc(ecallSummary(s))}</span>
        ${$('#ecallWindow').hidden ? '<button class="btn sm" data-ecall-window="open">開啟通話視窗</button>' : ''}</div>
    </div>`;
  }

  const hvac = deviceOfType(s, 'hvac');
  const audio = deviceOfType(s, 'audio');
  const buzzer = deviceOfType(s, 'buzzer');
  const mic = deviceOfType(s, 'audio_sensor');
  const ecuFault = s.devices.some((d) => d.type === 'ecu' && d.fault);
  html += `<div class="cards">
    <div class="mini"><div class="k">車外溫度</div><div class="v">${s.environment.ambientTempC} °C</div></div>
    <div class="mini"><div class="k">空調</div><div class="v">${hvac ? (hvac.powerState === 'NORMAL' || hvac.powerState === 'REDUCED' ? `${hvac.mode === 'HEATING' ? '暖氣' : hvac.mode === 'COOLING' ? '冷氣' : hvac.mode === 'OFF' ? '關閉' : hvac.mode === 'FAULT' ? '故障' : '送風'} ${hvac.on && !hvac.fault ? hvac.effectiveLevel + ' 檔' : ''}` : STATUS_LABEL[hvac.status]) : '—'}</div></div>
    <div class="mini"><div class="k">剩餘里程</div><div class="v">${ecuFault ? '— —' : s.environment.rangeKm + ' km'}</div></div>
    <div class="mini"><div class="k">音響</div><div class="v">${audioCardText(audio)}</div></div>
    <div class="mini"><div class="k">中控蜂鳴器</div><div class="v">${!buzzer ? '—' : buzzer.fault ? '故障' : s.buzzer ? '🔊 持續警示音' : '靜止'}</div></div>
    <div class="mini"><div class="k">音訊傳感器</div><div class="v">${!mic ? '未配置' : mic.fault ? '故障' : mic.mode === 'SIREN_DETECTED' ? `笛聲：${DIRECTION_LABEL[s.sensors.siren.direction]}` : '監聽中'}</div></div>
    ${blindSpotCard(s)}
  </div>`;

  html += navigationHtml(s, ecuFault);
  $('#cockpitBody').innerHTML = html;
}

// Behavior 3: radar DETECTED + same-side turn signal ACTIVE -> mirror LED FLASHING + buzzer.
function blindSpotCard(s) {
  const ts = deviceOfType(s, 'turn_signal');
  const tsText = !ts ? '未配置' : ts.fault ? '故障' : ts.mode === 'ACTIVE_LEFT' ? 'ACTIVE（◀ 左）' : ts.mode === 'ACTIVE_RIGHT' ? 'ACTIVE（右 ▶）' : 'IDLE（關閉）';
  const sides = ['left', 'right'].map((side) => {
    const radar = deviceOfType(s, 'bsd_radar', (d) => d.props && d.props.side === side);
    const mirror = deviceOfType(s, 'mirror', (d) => d.props && d.props.side === side);
    const radarMode = !radar ? 'NONE' : radar.fault ? 'FAULT' : radar.mode;
    const ledMode = !mirror ? 'NONE' : mirror.fault ? 'FAULT' : mirror.mode;
    const ledLabel = { FLASHING: '快速閃爍', STEADY: '恆亮', IDLE: '熄滅', FAULT: '故障', NONE: '未配置' }[ledMode] || ledMode;
    const radarLabel = { DETECTED: 'DETECTED', CLEAR: 'CLEAR', FAULT: '故障', NONE: '未配置' }[radarMode] || radarMode;
    return `<div class="bsd-side"><b>${SIDE_SHORT[side]}側</b>
      <span>雷達 <span class="radar ${radarMode}">${radarLabel}</span></span>
      <span class="led-wrap" title="${SIDE_SHORT[side]}後視鏡 LED：${ledLabel}"><i class="led ${ledMode}"></i>LED ${ledLabel}</span></div>`;
  }).join('');
  return `<div class="mini wide"><div class="k">盲區監測（雷達 → 後視鏡 LED）</div>
    <div class="bsd">${sides}<div class="bsd-side"><b>方向燈</b><span>${tsText}</span></div></div></div>`;
}

// Behavior 4: reachable stations only (distance <= range x factor), sorted by distance.
function navigationHtml(s, ecuFault) {
  const nav = s.navigation;
  const target = nav.stations.find((x) => x.id === nav.targetId);
  let html = '';
  if (s.lowRange.active && !ecuFault) {
    const reachable = nav.stations.filter((st) => st.reachable);
    const unreachable = nav.stations.filter((st) => !st.reachable);
    html += `<h3>推薦加油站 <span class="sub" style="font-weight:400">可抵達範圍：${s.environment.rangeKm} km × ${s.settings.reachableFactor} = ${nav.reachableKm} km，依距離排序</span></h3>`;
    if (reachable.length) {
      html += '<div class="table-wrap"><table><thead><tr><th>站名</th><th>距離</th><th>預估抵達消耗</th><th>抵達後剩餘</th><th></th></tr></thead><tbody>';
      html += reachable.map((st) => `<tr class="${st.id === nav.targetId ? 'target' : ''}">
        <td>${esc(st.name)}</td><td>${st.distanceKm} km</td><td>${st.fuelL} L</td><td>${st.rangeOnArrivalKm} km</td>
        <td>${st.id === nav.targetId ? '<button class="btn sm on" data-act="cancelNav">導航中・取消</button>' : `<button class="btn sm" data-nav="${st.id}">設定導航</button>`}</td></tr>`).join('');
      html += '</tbody></table></div>';
    } else {
      html += '<p class="hint"><b>附近無可抵達加油站，建議聯絡道路救援。</b></p>';
    }
    if (unreachable.length) {
      html += `<details class="unreach"><summary>超出可抵達範圍的加油站（${unreachable.length} 站，不列入推薦）</summary><ul>${unreachable.map((st) => `<li>${esc(st.name)}・${st.distanceKm} km</li>`).join('')}</ul></details>`;
    }
  } else if (target) {
    html += `<p class="hint nav-now">導航中：${esc(target.name)}（${target.distanceKm} km） <button class="btn sm" data-act="cancelNav">取消導航</button></p>`;
  }
  return html;
}

// ------------------------------------------------------------------ eCall call window
// The real phone call is out of scope; it is presented as a simulated call window
// (proposal §3 Out of Scope: 以模擬進度條與視窗呈現).
let ecallRenderedKey = null;
let ecallMinimisedKey = null;

function ecallKey(inc) { return `${inc.startedAt}|${inc.ecallState}`; }

function renderEcallWindow(s) {
  const w = $('#ecallWindow');
  const inc = s.incident;
  if (!inc.active) {
    w.hidden = true;
    w.innerHTML = '';
    ecallRenderedKey = null;
    ecallMinimisedKey = null;
    return;
  }
  const key = ecallKey(inc);
  if (ecallMinimisedKey && ecallMinimisedKey !== key) ecallMinimisedKey = null; // a new call state re-opens it
  const wasHidden = w.hidden;
  w.hidden = ecallMinimisedKey === key;
  if (ecallRenderedKey !== key) {
    w.innerHTML = ecallWindowHtml(s);
    ecallRenderedKey = key;
  } else {
    updateEcallWindow(s); // keep focus on the buttons: only refresh the changing numbers
  }
  if (wasHidden !== w.hidden) renderCockpit(s); // the "open window" button depends on it
}

function ecallWindowHtml(s) {
  const inc = s.incident;
  const dir = DIRECTION_LABEL[inc.direction] || '';
  const sideTag = inc.direction === 'front' ? '前側' : inc.direction === 'rear' ? '後側' : '';
  const service = ECALL_SERVICE_LABEL[inc.ecallService] || '';
  const pos = s.environment.position;
  const badge = { COUNTDOWN: 'critical', CALLING: 'warning', CONNECTED: 'ok', CANCELLED: 'info', FAULT: 'critical' }[inc.ecallState] || 'info';
  let body;
  switch (inc.ecallState) {
    case 'COUNTDOWN':
      body = `<div class="cw-count" aria-live="polite"><span data-bind="remaining">${inc.ecallRemainingS}</span> 秒</div>
        <div class="progress cw-bar"><div data-bind="countbar" style="width:${countdownPct(s)}%"></div></div>
        <p class="hint">倒數結束未選擇時，自動撥打 119（救護）並通報 110（警政）。</p>
        <div class="cw-actions">
          <button class="btn danger" data-act="selectEcall" data-service="119">撥打 119（救護）</button>
          <button class="btn danger" data-act="selectEcall" data-service="110">撥打 110（警政）</button>
        </div>
        <button class="btn cw-cancel" data-act="cancelEcall">我沒事，取消通報（誤觸）</button>`;
      break;
    case 'CALLING':
      body = `<div class="cw-status" aria-live="polite">📞 正在撥打 ${esc(service)}<span class="dots" aria-hidden="true"></span></div>
        <p class="hint">撥號中 <span data-bind="dial">${Math.max(0, s.simTime - inc.callStartedAt)}</span> 秒（模擬撥號，不會真的撥出）</p>`;
      break;
    case 'CONNECTED':
      body = `<div class="cw-status ok" aria-live="polite">✅ 已連線 ${esc(service)}</div>
        <p>通話時間 <b data-bind="talk">${fmtDuration(Math.max(0, s.simTime - inc.connectedAt))}</b></p>
        <dl class="cw-data">
          <dt>已傳送 GPS 座標</dt><dd>${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}</dd>
          <dt>撞擊方向</dt><dd>${esc(dir)}（${sideTag}）</dd>
          <dt>衝擊值</dt><dd>${inc.impactG} g</dd>
        </dl>`;
      break;
    case 'FAULT':
      body = `<div class="cw-status crit" aria-live="assertive">⚠ eCall 模組故障，自動通報已中斷</div>
        <p>請手動撥打 119（救護）或 110（警政）。</p>`;
      break;
    case 'CANCELLED':
      body = `<div class="cw-status" aria-live="polite">駕駛已取消通報</div>
        <p class="hint">事故仍在處理中（影像存證繼續）；確認安全後由 TA 按「解除事故」。</p>
        <button class="btn" data-ecall-window="min">關閉視窗</button>`;
      break;
    default:
      body = '';
  }
  return `<div class="cw-head">
      <span class="cw-title" id="ecallTitle">eCall 緊急通報</span>
      <span class="badge ${badge}">${ECALL_LABEL[inc.ecallState] || esc(inc.ecallState)}</span>
      <button class="btn sm" data-ecall-window="min" aria-label="縮小通話視窗" title="縮小（Esc）">—</button>
    </div>
    <div class="cw-info">碰撞方位：${esc(dir)}（${sideTag}）・衝擊 ${inc.impactG} g</div>
    ${body}`;
}

function countdownPct(s) {
  const total = s.settings.ecallCountdownS || 1;
  return Math.max(0, Math.min(100, (s.incident.ecallRemainingS / total) * 100));
}

function updateEcallWindow(s) {
  const w = $('#ecallWindow');
  const inc = s.incident;
  const set = (name, text) => { const el = w.querySelector(`[data-bind="${name}"]`); if (el) el.textContent = text; };
  set('remaining', inc.ecallRemainingS);
  const bar = w.querySelector('[data-bind="countbar"]');
  if (bar) bar.style.width = `${countdownPct(s)}%`;
  if (inc.callStartedAt !== null) set('dial', Math.max(0, s.simTime - inc.callStartedAt));
  if (inc.connectedAt !== null) set('talk', fmtDuration(Math.max(0, s.simTime - inc.connectedAt)));
}

function setEcallWindow(open) {
  if (!state || !state.incident.active) return;
  ecallMinimisedKey = open ? null : ecallKey(state.incident);
  renderEcallWindow(state);
}

// ------------------------------------------------------------------ power
const PRIO_COLOR = ['var(--p0)', 'var(--p1)', 'var(--p2)', 'var(--p3)'];

function renderPower(s) {
  const p = s.power;
  const scaleMax = Math.max(p.capacityW, p.requestedW, 1) * 1.1;
  const pct = (w) => (w / scaleMax) * 100;
  const byPrio = [0, 0, 0, 0];
  for (const d of s.devices) byPrio[d.priority] += d.drawW;
  let left = 0;
  const segs = byPrio.map((w, i) => {
    const html = `<div class="seg-bar" style="left:${pct(left)}%;width:${pct(w)}%;background:${PRIO_COLOR[i]}" title="P${i}: ${w} W"></div>`;
    left += w;
    return html;
  }).join('');
  const affected = s.devices.filter((d) => d.powerState !== 'NORMAL');
  const over = p.requestedPct !== null && p.requestedPct > 100;

  $('#powerBody').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
      <div><span class="big">${p.demandW}</span> / ${p.capacityW} W　<span class="hint">實際負載率 ${pctText(p.loadPct)}</span></div>
      <span class="badge ${p.status}">${POWER_LABEL[p.status]}</span>
    </div>
    <div class="gauge" role="img" aria-label="實際用電 ${p.demandW} W，容量 ${p.capacityW} W">
      ${segs}
      <div class="mark" style="left:${pct(p.capacityW * s.settings.highLoadPct / 100)}%" title="${s.settings.highLoadPct}%"></div>
      <div class="mark" style="left:${pct(p.capacityW)}%;opacity:.9" title="容量上限"></div>
    </div>
    <div class="gauge-scale"><span style="left:${pct(p.capacityW * s.settings.highLoadPct / 100)}%">${s.settings.highLoadPct}%</span><span style="left:${pct(p.capacityW)}%">${p.capacityW} W</span></div>
    <div class="legend">${['P0 安全', 'P1 必要舒適', 'P2 舒適', 'P3 娛樂'].map((l, i) => `<span><i style="background:${PRIO_COLOR[i]}"></i>${l} ${byPrio[i]} W</span>`).join('')}</div>
    <div class="cards">
      <div class="mini ${over ? 'over' : ''}"><div class="k">設備需求（管理前）</div><div class="v">${p.requestedW} W・${pctText(p.requestedPct)}</div>${over ? '<div class="k">負載率 &gt; 100%：啟動負載管理</div>' : ''}</div>
      <div class="mini"><div class="k">供電來源</div><div class="v">${p.alternatorFault ? '電瓶（故障模式）' : '發電機'}</div></div>
    </div>
    <h3>負載管理決策</h3>
    ${affected.length ? `<div class="table-wrap"><table><thead><tr><th>設備</th><th>等級</th><th>處置</th><th>原因</th></tr></thead><tbody>${affected.map((d) => `<tr><td>${esc(d.name)}</td><td><span class="prio p${d.priority}">P${d.priority}</span></td><td><span class="badge ${d.powerState}">${POWER_STATE_LABEL[d.powerState]}${d.powerState === 'REDUCED' ? ` ${d.level}→${d.effectiveLevel} 檔` : ''}</span></td><td>${REASON_LABEL[d.powerReason] || ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">無，所有設備依需求供電。</p>'}
  `;
}

// ------------------------------------------------------------------ zones
function deviceControls(d) {
  if (!d.userControl) return '';
  const parts = [];
  parts.push(`<button class="btn sm ${d.on ? 'on' : ''}" data-dev="${d.id}" data-op="toggle">${d.on ? '開' : '關'}</button>`);
  if (d.adjustable) {
    parts.push(`<label>${d.type === 'audio' ? '音量' : '檔位'} <input type="range" min="${d.minLevel}" max="${d.maxLevel}" value="${d.level}" data-dev="${d.id}" data-op="level"> ${d.level}</label>`);
  }
  if (d.variableLoad) {
    parts.push(`<label>負載 <input type="number" min="0" max="300" step="10" value="${d.load}" data-dev="${d.id}" data-op="load"> W</label>`);
  }
  if (d.hasAuto) {
    parts.push(`<label><input type="checkbox" ${d.auto ? 'checked' : ''} data-dev="${d.id}" data-op="auto"> 自動</label>`);
  }
  return `<div class="controls">${parts.join('')}</div>`;
}

// Passenger-facing explanation of what load management did to a device.
function powerNote(d) {
  if (d.powerState === 'NORMAL') return '';
  if (d.powerReason === 'EMERGENCY_RESERVE') return '已卸載・緊急電力保留（事故解除後恢復）';
  if (d.powerState === 'REDUCED') return `已降載 ${d.level}→${d.effectiveLevel} 檔・電力超載（容量回升後自動恢復）`;
  if (d.powerState === 'DEFERRED') return '延後啟動・電力不足（容量回升後自動啟動）';
  return '已卸載・電力超載（容量回升後自動恢復）';
}

function renderZones(s) {
  const html = s.zones.map((z) => {
    const devs = s.devices.filter((d) => d.zone === z.id);
    return `<div class="zone"><h3><span>${esc(z.name)}</span><span class="zone-meta"><span class="badge ${z.status}" title="分區狀態：區內最嚴重的設備狀態">${STATUS_LABEL[z.status] || z.status}</span><span class="w">${z.drawW} W</span></span></h3>
      ${devs.length ? devs.map((d) => `<div class="dev status-${d.status}">
        <div class="line1"><span class="prio p${d.priority}" title="優先等級">P${d.priority}</span><span class="name">${esc(d.name)}</span>
          <span class="badge ${d.status}">${STATUS_LABEL[d.status] || d.status}</span><span class="w">${d.drawW} W</span></div>
        <div class="line2"><span class="mode">${esc(d.mode)}</span>
          ${d.powerState !== 'NORMAL' ? `<span class="power-note">${powerNote(d)}</span>` : ''}
          ${d.props && d.props.side ? `<span>${SIDE_SHORT[d.props.side]}側</span>` : ''}
          ${d.props && d.props.position ? `<span>${d.props.position === 'front' ? '前' : '後'}側</span>` : ''}</div>
        ${deviceControls(d)}
      </div>`).join('') : '<p class="empty">此區域尚無設備</p>'}
    </div>`;
  }).join('');
  $('#zones').innerHTML = html;
}

// ------------------------------------------------------------------ console
let consoleInit = false;
function renderConsole(s) {
  if (!consoleInit) {
    $('#scenarios').innerHTML = s.scenarios.map((sc) => `<button class="btn sm" data-scenario="${sc.id}" title="${esc(sc.description)}">${esc(sc.label)}</button>`).join('');
    consoleInit = true;
  }
  const sel = $('#faultDevice');
  const ids = s.devices.map((d) => d.id).join(',');
  if (sel.dataset.ids !== ids) {
    const cur = sel.value;
    sel.innerHTML = s.devices.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    if (s.devices.some((d) => d.id === cur)) sel.value = cur;
    sel.dataset.ids = ids;
  }
  const faults = s.devices.filter((d) => d.fault).map((d) => d.name);
  $('#faultList').textContent = faults.length ? `故障中：${faults.join('、')}` : '目前沒有故障設備';

  $('#bsLeft').classList.toggle('on', s.sensors.blindSpot.left);
  $('#bsRight').classList.toggle('on', s.sensors.blindSpot.right);
  $('#btnSirenOn').classList.toggle('on', s.sensors.siren.active);
  for (const v of ['left', 'off', 'right']) $(`#ts${v[0].toUpperCase() + v.slice(1)}`).classList.toggle('on', s.sensors.turnSignal === v);
  $('#btnAlt').classList.toggle('on', s.power.alternatorFault);
  $('#btnAlt').textContent = s.power.alternatorFault ? '發電機故障中（點擊恢復）' : '發電機故障';
  const canChoose = s.incident.active && s.incident.ecallState === 'COUNTDOWN';
  $('#btnCancelEcall').disabled = !canChoose;
  $('#btnEcall119').disabled = !canChoose;
  $('#btnEcall110').disabled = !canChoose;
  $('#btnClearIncident').disabled = !s.incident.active;
  const target = s.navigation.stations.find((x) => x.id === s.navigation.targetId);
  $('#btnCancelNav').disabled = !target;
  $('#navNow').textContent = target ? `導航中：${target.name}` : '';
  const amb = $('#ambient');
  if (document.activeElement !== amb) amb.value = s.environment.ambientTempC;
  $('#ambientVal').textContent = `${amb.value} °C`;
  const cap = $('#capacityW');
  if (document.activeElement !== cap) cap.value = s.settings.capacityW;
}

function renderLog(s) {
  const kind = $('#logKind').value;
  const items = s.log.filter((l) => !kind || l.kind === kind).slice().reverse();
  $('#log').innerHTML = items.length
    ? items.map((l) => `<li><span class="t">${fmtTime(l.t)}</span><span class="k ${l.kind}">${l.kind}</span><span>${esc(l.message)}</span></li>`).join('')
    : '<li class="empty-row">沒有符合的日誌</li>';
  $('#logCount').textContent = `畫面顯示最近 ${s.log.length} 筆（共 ${s.logTotal} 筆）；匯出可取得完整日誌以比對重現結果。`;
}

// ------------------------------------------------------------------ sound (audible alerts)
// Browsers only allow audio after a user gesture, so sound is opt-in from the header button.
const CHIME_ALERTS = ['siren', 'low-range']; // 救護車避讓、加油站推薦
const sound = { on: false, ctx: null, timer: null, seen: new Set() };

function beep(freq, ms, { type = 'square', vol = 0.05, at = 0 } = {}) {
  const ctx = sound.ctx;
  if (!ctx) return;
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}

function chime() {
  beep(880, 220, { type: 'sine', vol: 0.12 });
  beep(660, 320, { type: 'sine', vol: 0.12, at: 0.24 });
}

function updateSound(s) {
  const buzzing = sound.on && s.buzzer;
  if (buzzing && !sound.timer) {
    beep(1800, 120);
    sound.timer = setInterval(() => beep(1800, 120), 280); // continuous warning tone
  } else if (!buzzing && sound.timer) {
    clearInterval(sound.timer);
    sound.timer = null;
  }
  const ids = new Set(s.alerts.map((a) => a.id));
  if (sound.on && CHIME_ALERTS.some((id) => ids.has(id) && !sound.seen.has(id))) chime();
  sound.seen = ids;
}

function toggleSound() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!sound.on && !AC) {
    toast('此瀏覽器不支援 Web Audio，無法播放警示音');
    return;
  }
  sound.on = !sound.on;
  if (sound.on) {
    if (!sound.ctx) sound.ctx = new AC();
    sound.ctx.resume();
    beep(1200, 60, { type: 'sine', vol: 0.08 });
  }
  const b = $('#soundToggle');
  b.setAttribute('aria-pressed', String(sound.on));
  b.classList.toggle('on', sound.on);
  b.textContent = sound.on ? '🔊 警示音：開' : '🔈 警示音：關';
  if (state) updateSound(state);
}

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'soundToggle') return toggleSound();
  if (b.dataset.ecallWindow) return setEcallWindow(b.dataset.ecallWindow === 'open');
  if (b.dataset.clock === 'toggle') return act({ type: 'clock', command: state.clockRunning ? 'pause' : 'resume' });
  if (b.dataset.clock === 'step') return act({ type: 'clock', command: 'step', seconds: Number(b.dataset.sec) });
  if (b.dataset.scenario) return act({ type: 'scenario', name: b.dataset.scenario });
  if (b.dataset.nav) return act({ type: 'navigate', stationId: b.dataset.nav });
  if (b.dataset.range) { $('#rangeKm').value = b.dataset.range; return act({ type: 'setRange', km: Number(b.dataset.range) }); }
  if (b.dataset.dev && b.dataset.op === 'toggle') {
    const d = state.devices.find((x) => x.id === b.dataset.dev);
    return act({ type: 'setDevice', id: d.id, on: !d.on });
  }
  switch (b.dataset.act) {
    case 'impact': return act({ type: 'impact', g: Number($('#impactG').value), direction: b.dataset.dir || 'front' });
    case 'selectEcall': return act({ type: 'selectEcall', service: b.dataset.service });
    case 'cancelEcall': return act({ type: 'cancelEcall' });
    case 'clearIncident': return act({ type: 'clearIncident' });
    case 'sirenOn': return act({ type: 'siren', active: true, direction: $('#sirenDir').value });
    case 'sirenOff': return act({ type: 'siren', active: false });
    case 'bs': return act({ type: 'blindSpot', side: b.dataset.side, detected: !state.sensors.blindSpot[b.dataset.side] });
    case 'ts': return act({ type: 'turnSignal', value: b.dataset.val });
    case 'setRange': return act({ type: 'setRange', km: Number($('#rangeKm').value) });
    case 'cancelNav': return act({ type: 'cancelNavigation' });
    case 'setCapacity': return act({ type: 'setCapacity', watts: Number($('#capacityW').value) });
    case 'altFault': return act({ type: 'setAlternatorFault', fault: !state.power.alternatorFault });
    case 'fault': return act({ type: 'setFault', id: $('#faultDevice').value, fault: b.dataset.val === '1' });
    case 'reset': return act({ type: 'reset' });
    case 'factoryReset':
      if (confirm('確定恢復原廠配置？自訂的區域與設備會被清除。')) return act({ type: 'factoryReset' });
      return undefined;
    default: return undefined;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#ecallWindow').hidden) setEcallWindow(false);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'ambient') return act({ type: 'setAmbient', celsius: Number(el.value) });
  if (el.id === 'logKind') return state && renderLog(state);
  if (!el.dataset.dev) return undefined;
  interacting = false;
  const id = el.dataset.dev;
  if (el.dataset.op === 'level') return act({ type: 'setDevice', id, level: Number(el.value) });
  if (el.dataset.op === 'load') return act({ type: 'setDevice', id, load: Number(el.value) });
  if (el.dataset.op === 'auto') return act({ type: 'setDevice', id, auto: el.checked });
  return undefined;
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'ambient') $('#ambientVal').textContent = `${e.target.value} °C`;
});

// Don't re-render the device list while the user is dragging a slider or typing.
const zonesEl = $('#zones');
zonesEl.addEventListener('pointerdown', (e) => { if (e.target.matches('input')) interacting = true; });
zonesEl.addEventListener('focusin', (e) => { if (e.target.matches('input[type=number]')) interacting = true; });
zonesEl.addEventListener('focusout', () => { interacting = false; if (state) renderZones(state); });
document.addEventListener('pointerup', () => { setTimeout(() => { if (interacting && !zonesEl.contains(document.activeElement)) { interacting = false; } }, 0); });

fetch('/api/state').then((r) => r.json()).then(render).catch((err) => toast(err.message));
connect();
