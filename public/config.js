'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SETTING_LABELS = {
  capacityW: '發電機容量 (W)',
  batteryW: '電瓶模式容量 (W)',
  highLoadPct: '高負載門檻 (%)',
  impactThresholdG: '撞擊閾值 (g)',
  ecallCountdownS: 'eCall 倒數 (秒)',
  ecallConnectS: 'eCall 撥號至連線 (秒)',
  uploadDurationS: '影像上傳時間 (秒)',
  lowRangeKm: '低里程警示 (km)',
  lowRangeClearKm: '低里程解除 (km)',
  criticalRangeKm: '極低里程 (km)',
  reachableFactor: '可抵達係數',
  fuelLPerKm: '油耗 (L/km)',
  targetTempC: '座艙目標溫度 (°C)',
  defrostOnC: '自動除霧開啟 (°C)',
  defrostOffC: '自動除霧關閉 (°C)',
};

let cfg = null;

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'alert');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(method, url, body) {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    render(data);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

function priorityOptions(type, selected) {
  const t = cfg.deviceTypes[type];
  const allowed = t.fixedPriority === 0 ? [0] : [1, 2, 3];
  return allowed.map((p) => `<option value="${p}" ${p === selected ? 'selected' : ''}>P${p}</option>`).join('');
}

function zoneOptions(selected) {
  return cfg.zones.map((z) => `<option value="${z.id}" ${z.id === selected ? 'selected' : ''}>${esc(z.name)}</option>`).join('');
}

function render(data) {
  cfg = data;
  $('#zoneRows').innerHTML = cfg.zones.map((z) => {
    const n = cfg.devices.filter((d) => d.zone === z.id).length;
    return `<tr><td>${esc(z.id)}</td><td><input type="text" value="${esc(z.name)}" data-zone-name="${z.id}"></td><td>${n}</td>
      <td><button class="btn sm" data-zone-save="${z.id}">儲存</button> <button class="btn sm" data-zone-del="${z.id}" ${n ? 'disabled title="區域內仍有設備"' : ''}>刪除</button></td></tr>`;
  }).join('');

  $('#deviceRows').innerHTML = cfg.devices.map((d) => {
    const t = cfg.deviceTypes[d.type];
    const side = d.props.side ? `（${d.props.side === 'left' ? '左' : '右'}）` : d.props.position ? `（${d.props.position === 'front' ? '前' : '後'}）` : '';
    return `<tr data-row="${d.id}">
      <td>${esc(d.id)}</td><td>${esc(t.label)}${side}</td>
      <td><input type="text" value="${esc(d.name)}" data-f="name"></td>
      <td><select data-f="zone">${zoneOptions(d.zone)}</select></td>
      <td><select data-f="priority" ${t.fixedPriority === 0 ? 'disabled' : ''}>${priorityOptions(d.type, d.priority)}</select></td>
      <td><input type="number" value="${d.shedOrder}" min="0" max="999" data-f="shedOrder" ${t.fixedPriority === 0 ? 'disabled' : ''}></td>
      <td><input type="number" value="${d.ratedW}" min="0" max="2000" data-f="ratedW" ${d.type === 'inverter' ? 'disabled title="逆變器耗電依插入負載"' : ''}></td>
      <td style="white-space:nowrap"><button class="btn sm" data-dev-save="${d.id}">儲存</button> <button class="btn sm" data-dev-del="${d.id}">刪除</button></td></tr>`;
  }).join('');

  const typeSel = $('#newType');
  if (!typeSel.options.length) {
    typeSel.innerHTML = Object.entries(cfg.deviceTypes).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    onTypeChange();
  }
  const zoneSel = $('#newZone');
  const curZone = zoneSel.value;
  zoneSel.innerHTML = zoneOptions(curZone);

  const sf = $('#settingsForm');
  if (!sf.dataset.ready) {
    sf.innerHTML = Object.keys(cfg.settings).map((k) => `<label>${esc(SETTING_LABELS[k] || k)}<input type="number" step="any" name="${k}"></label>`).join('');
    sf.dataset.ready = '1';
  }
  for (const [k, v] of Object.entries(cfg.settings)) sf.elements[k].value = v;
}

function onTypeChange() {
  const type = $('#newType').value;
  const t = cfg.deviceTypes[type];
  $('#newPriority').innerHTML = priorityOptions(type, t.fixedPriority === 0 ? 0 : t.defaultPriority);
  $('#newRated').value = t.ratedW;
  $('#newRated').disabled = type === 'inverter';
  $('#sideWrap').hidden = !t.props.includes('side');
  $('#posWrap').hidden = !t.props.includes('position');
}

$('#newType').addEventListener('change', onTypeChange);

$('#zoneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (await api('POST', '/api/zones', { id: f.id.value.trim(), name: f.name.value })) e.target.reset();
});

$('#deviceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const t = cfg.deviceTypes[f.type.value];
  const body = {
    id: f.id.value.trim(), type: f.type.value, name: f.name.value, zone: f.zone.value,
    priority: Number(f.priority.value), shedOrder: f.shedOrder.value, ratedW: f.ratedW.disabled ? undefined : f.ratedW.value,
    props: {},
  };
  if (t.props.includes('side')) body.props.side = f.side.value;
  if (t.props.includes('position')) body.props.position = f.position.value;
  if (await api('POST', '/api/devices', body)) { f.id.value = ''; f.name.value = ''; }
});

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = {};
  for (const k of Object.keys(cfg.settings)) body[k] = e.target.elements[k].value;
  api('PUT', '/api/settings', body).then((ok) => ok && toastOk('參數已儲存'));
});

function toastOk(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.background = 'var(--ok)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.zoneSave) {
    const name = document.querySelector(`[data-zone-name="${b.dataset.zoneSave}"]`).value;
    api('PUT', `/api/zones/${b.dataset.zoneSave}`, { name });
  } else if (b.dataset.zoneDel) {
    if (confirm('確定刪除此區域？')) api('DELETE', `/api/zones/${b.dataset.zoneDel}`);
  } else if (b.dataset.devSave) {
    const row = document.querySelector(`tr[data-row="${b.dataset.devSave}"]`);
    const body = {};
    for (const el of row.querySelectorAll('[data-f]')) if (!el.disabled) body[el.dataset.f] = el.dataset.f === 'priority' ? Number(el.value) : el.value;
    api('PUT', `/api/devices/${b.dataset.devSave}`, body).then((ok) => ok && toastOk('已儲存'));
  } else if (b.dataset.devDel) {
    if (confirm('確定刪除此設備？')) api('DELETE', `/api/devices/${b.dataset.devDel}`);
  }
});

fetch('/api/config').then((r) => r.json()).then(render).catch((err) => toast(err.message));
