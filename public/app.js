'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_LABEL = {
  NORMAL: '正常', WARNING: '警示', EMERGENCY: '緊急', STANDBY: '待機',
  SHED: '已卸載', DEFERRED: '延後啟動', FAULT: '故障',
};
const DIRECTION_LABEL = { front: '前方', rear: '後方', left: '左側', right: '右側' };
const ECALL_SERVICE_LABEL = { 119: '119（救護）', 110: '110（警政）', both: '119（救護）＋110（警政）' };
const POWER_LABEL = { NORMAL: '正常', HIGH_LOAD: '高負載', OVERLOAD: '超載・負載管理中', CRITICAL_POWER: '電力危急' };
const POWER_STATE_LABEL = { REDUCED: '降載', SHED: '已卸載', DEFERRED: '延後啟動' };
const REASON_LABEL = { OVERLOAD: '超載', EMERGENCY_RESERVE: '緊急電力保留' };
const ECALL_LABEL = { COUNTDOWN: '倒數中', CALLING: '撥號中', CONNECTED: '已連線', CANCELLED: '已取消', FAULT: '故障' };

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
  renderClock(s);
  renderCockpit(s);
  renderPower(s);
  if (!interacting) renderZones(s);
  renderConsole(s);
  renderLog(s);
}

const fmtTime = (t) => `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

function renderClock(s) {
  $('#clockTime').textContent = fmtTime(s.simTime);
  $('#clockDot').classList.toggle('running', s.clockRunning);
  $('#clockToggle').textContent = s.clockRunning ? '暫停' : '繼續';
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
    const service = ECALL_SERVICE_LABEL[inc.ecallService] || '119 / 110';
    html += `<div class="ecall">
      <div class="dir-tag">碰撞方向：${esc(dirLabel)}${inc.direction === 'front' ? '（前側）' : inc.direction === 'rear' ? '（後側）' : ''}・衝擊 ${inc.impactG} g</div>
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
        <div><div class="k">eCall 緊急通報${inc.ecallService ? `：${esc(service)}` : '（119 / 110）'}</div>
          <div class="count">${inc.ecallState === 'COUNTDOWN' ? inc.ecallRemainingS + ' 秒' : esc(ECALL_LABEL[inc.ecallState] || inc.ecallState)}</div></div>
        ${inc.ecallState === 'COUNTDOWN' ? `<div class="ecall-actions">
          <button class="btn danger" data-act="selectEcall" data-service="119">撥打 119（救護）</button>
          <button class="btn danger" data-act="selectEcall" data-service="110">撥打 110（警政）</button>
          <button class="btn" data-act="cancelEcall">我沒事，取消通報</button></div>` : ''}
      </div>
      ${inc.ecallState === 'COUNTDOWN' ? '<p class="hint">倒數結束未選擇時，自動撥打 119 並通報 110。</p>' : ''}
      ${inc.ecallState === 'CONNECTED' ? `<p class="hint">已傳送 GPS：${s.environment.position.lat.toFixed(4)}, ${s.environment.position.lng.toFixed(4)}・撞擊方向：${esc(dirLabel)}・衝擊 ${inc.impactG} g</p>` : ''}
      <div class="hint" style="margin-top:8px">影像雲端存證${upName ? `（${struckSide ? `受撞擊側 ${esc(upName)}` : `${esc(dirLabel)}記錄器無法使用，改由 ${esc(upName)}`}）` : ''}：${upName ? Math.round(inc.uploadProgress) + '%' : '無可用記錄器'}${upName ? '・其餘記錄器 EMERGENCY_LOCK 鎖定保存' : ''}</div>
      <div class="progress"><div style="width:${upName ? inc.uploadProgress : 0}%"></div></div>
    </div>`;
  }

  const hvac = s.devices.find((d) => d.type === 'hvac');
  const audio = s.devices.find((d) => d.type === 'audio');
  html += `<div class="cards">
    <div class="mini"><div class="k">車外溫度</div><div class="v">${s.environment.ambientTempC} °C</div></div>
    <div class="mini"><div class="k">空調</div><div class="v">${hvac ? (hvac.powerState === 'NORMAL' || hvac.powerState === 'REDUCED' ? `${hvac.mode === 'HEATING' ? '暖氣' : hvac.mode === 'COOLING' ? '冷氣' : hvac.mode === 'OFF' ? '關閉' : '送風'} ${hvac.on ? hvac.effectiveLevel + ' 檔' : ''}` : STATUS_LABEL[hvac.status]) : '—'}</div></div>
    <div class="mini"><div class="k">剩餘里程</div><div class="v">${s.devices.some((d) => d.type === 'ecu' && d.fault) ? '— —' : s.environment.rangeKm + ' km'}</div></div>
    <div class="mini"><div class="k">音響</div><div class="v">${audio ? (audio.powerReason === 'EMERGENCY_RESERVE' ? '緊急卸載' : audio.status === 'SHED' || audio.status === 'DEFERRED' ? STATUS_LABEL[audio.status] : audio.mode === 'MUTED' ? '🔇 靜音' : audio.on ? '音量 ' + audio.level : '關閉') : '—'}</div></div>
    <div class="mini"><div class="k">蜂鳴器</div><div class="v">${s.buzzer ? '🔊 警示音' : '靜止'}</div></div>
    <div class="mini"><div class="k">後視鏡盲區 LED</div><div class="v leds">${['left', 'right'].map((side) => {
      const m = s.devices.find((d) => d.type === 'mirror' && d.props && d.props.side === side);
      const mode = m ? (m.fault ? 'FAULT' : m.mode) : 'NONE';
      const label = { FLASHING: '快速閃爍', STEADY: '恆亮', IDLE: '熄滅', FAULT: '故障', NONE: '—' }[mode] || mode;
      return `<span class="led-wrap" title="${side === 'left' ? '左' : '右'}後視鏡：${label}"><i class="led ${mode}"></i>${side === 'left' ? '左' : '右'}</span>`;
    }).join('')}</div></div>
  </div>`;

  const nav = s.navigation;
  const target = nav.stations.find((x) => x.id === nav.targetId);
  if (s.lowRange.active && !s.devices.some((d) => d.type === 'ecu' && d.fault)) {
    html += `<h3>推薦加油站 <span class="sub" style="font-weight:400">可抵達：距離 ≤ 剩餘里程 × ${s.settings.reachableFactor}（${(s.environment.rangeKm * s.settings.reachableFactor).toFixed(1)} km）</span></h3>`;
    html += '<div class="table-wrap"><table><thead><tr><th>加油站</th><th>距離</th><th>預估耗油</th><th>抵達剩餘</th><th></th></tr></thead><tbody>';
    html += nav.stations.map((st) => `<tr class="${st.reachable ? '' : 'unreachable'} ${st.id === nav.targetId ? 'target' : ''}">
      <td>${esc(st.name)}</td><td>${st.distanceKm} km</td><td>${st.fuelL} L</td><td>${st.reachable ? st.rangeOnArrivalKm + ' km' : '無法抵達'}</td>
      <td>${st.reachable ? `<button class="btn sm" data-nav="${st.id}">${st.id === nav.targetId ? '導航中' : '設定導航'}</button>` : ''}</td></tr>`).join('');
    html += '</tbody></table></div>';
    if (!nav.recommended.length) html += '<p class="hint"><b>附近無可抵達加油站，建議聯絡道路救援。</b></p>';
  } else if (target) {
    html += `<p class="hint">導航中：${esc(target.name)}（${target.distanceKm} km）</p>`;
  }
  $('#cockpitBody').innerHTML = html;
}

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

  $('#powerBody').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
      <div><span class="big">${p.demandW}</span> / ${p.capacityW} W　<span class="hint">負載率 ${p.loadPct}%</span></div>
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
      <div class="mini"><div class="k">設備需求（管理前）</div><div class="v">${p.requestedW} W</div></div>
      <div class="mini"><div class="k">供電來源</div><div class="v">${p.alternatorFault ? '電瓶（故障模式）' : '發電機'}</div></div>
    </div>
    <h3>負載管理決策</h3>
    ${affected.length ? `<table><thead><tr><th>設備</th><th>等級</th><th>處置</th><th>原因</th></tr></thead><tbody>${affected.map((d) => `<tr><td>${esc(d.name)}</td><td><span class="prio p${d.priority}">P${d.priority}</span></td><td><span class="badge ${d.powerState}">${POWER_STATE_LABEL[d.powerState]}${d.powerState === 'REDUCED' ? ` ${d.level}→${d.effectiveLevel} 檔` : ''}</span></td><td>${REASON_LABEL[d.powerReason] || ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">無，所有設備依需求供電。</p>'}
  `;
}

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

function renderZones(s) {
  const html = s.zones.map((z) => {
    const devs = s.devices.filter((d) => d.zone === z.id);
    const w = devs.reduce((a, d) => a + d.drawW, 0);
    return `<div class="zone"><h3><span>${esc(z.name)}</span><span class="w">${w} W</span></h3>
      ${devs.length ? devs.map((d) => `<div class="dev status-${d.status}">
        <div class="line1"><span class="prio p${d.priority}" title="優先等級">P${d.priority}</span><span class="name">${esc(d.name)}</span>
          <span class="badge ${d.status}">${STATUS_LABEL[d.status] || d.status}</span><span class="w">${d.drawW} W</span></div>
        <div class="line2"><span class="mode">${esc(d.mode)}</span>
          ${d.powerState !== 'NORMAL' ? `<span>${POWER_STATE_LABEL[d.powerState]}${d.powerState === 'REDUCED' ? `（${d.level}→${d.effectiveLevel} 檔）` : ''}・${REASON_LABEL[d.powerReason] || ''}</span>` : ''}
          ${d.props && d.props.side ? `<span>${d.props.side === 'left' ? '左' : '右'}側</span>` : ''}
          ${d.props && d.props.position ? `<span>${d.props.position === 'front' ? '前' : '後'}側</span>` : ''}</div>
        ${deviceControls(d)}
      </div>`).join('') : '<p class="empty">此區域尚無設備</p>'}
    </div>`;
  }).join('');
  $('#zones').innerHTML = html;
}

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
  for (const v of ['left', 'off', 'right']) $(`#ts${v[0].toUpperCase() + v.slice(1)}`).classList.toggle('on', s.sensors.turnSignal === v);
  $('#btnAlt').classList.toggle('on', s.power.alternatorFault);
  $('#btnAlt').textContent = s.power.alternatorFault ? '發電機故障中（點擊恢復）' : '發電機故障';
  const canChoose = s.incident.active && s.incident.ecallState === 'COUNTDOWN';
  $('#btnCancelEcall').disabled = !canChoose;
  $('#btnEcall119').disabled = !canChoose;
  $('#btnEcall110').disabled = !canChoose;
  $('#btnClearIncident').disabled = !s.incident.active;
  const amb = $('#ambient');
  if (document.activeElement !== amb) amb.value = s.environment.ambientTempC;
  $('#ambientVal').textContent = `${amb.value} °C`;
  const cap = $('#capacityW');
  if (document.activeElement !== cap) cap.value = s.settings.capacityW;
}

function renderLog(s) {
  $('#log').innerHTML = s.log.slice().reverse().map((l) => `<li><span class="t">${fmtTime(l.t)}</span><span class="k ${l.kind}">${l.kind}</span><span>${esc(l.message)}</span></li>`).join('');
}

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
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

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'ambient') return act({ type: 'setAmbient', celsius: Number(el.value) });
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
