/* global $, M, translateAll */
/**
 * nexowatt-devices - admin (materialize) UI
 * This UI is intentionally robust: it works even if Materialize-JS plugins are not available.
 */

'use strict';

let templatesData = null;
let templatesById = {};
let categories = [];
let manufacturersByCategory = {}; // cat -> [manu]
let templatesByCatManu = {}; // cat -> manu -> [template]
let devices = [];
let editIndex = -1;
let onChangeGlobal = null;
let uiInitialized = false;
let lastSuggestedId = '';
let lastSuggestedName = '';

// Serial port discovery (Admin UI)
let serialPortsCache = [];
let serialPortsLastFetchMs = 0;
let serialPortsTimer = null;
let serialPortsFetchInFlight = false;

function normalizeSerialPortsResponse(res) {
  // Accept both: ["/dev/ttyUSB0", ...] and [{value:"/dev/ttyUSB0"}, ...]
  const out = [];
  if (Array.isArray(res)) {
    for (const x of res) {
      if (!x) continue;
      if (typeof x === 'string') out.push(x);
      else if (typeof x === 'object') {
        const v = (x.value || x.path || x.comName || '').toString();
        if (v) out.push(v);
      }
    }
  }
  // Deduplicate
  return Array.from(new Set(out.filter(Boolean)));
}

function setSerialPortsDatalist(paths) {
  // NOTE: historic name kept. We now populate real <select> dropdowns (like ioBroker modbus adapter),
  // not a HTML5 datalist, because users expect a selectable list.

  const curMb = ($('#mb_path').val() || '').trim();
  const curMbus = ($('#mbus_path').val() || '').trim();

  // Always include current values so they remain selectable
  const all = new Set(paths || []);
  if (curMb) all.add(curMb);
  if (curMbus) all.add(curMbus);

  // Add common fallbacks
  ['/dev/serial/by-id/', '/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyAMA0', '/dev/ttyAMA10', '/dev/com2', 'COM3', 'COM4'].forEach(p => all.add(p));

  const arr = Array.from(all).filter(Boolean);
  // Prefer /dev/serial/by-id first
  arr.sort((a, b) => {
    const ka = a.startsWith('/dev/serial/by-id/') ? '0_' + a : a.startsWith('/dev/tty') ? '1_' + a : a.startsWith('/dev/com') ? '2_' + a : '9_' + a;
    const kb = b.startsWith('/dev/serial/by-id/') ? '0_' + b : b.startsWith('/dev/tty') ? '1_' + b : b.startsWith('/dev/com') ? '2_' + b : '9_' + b;
    return ka.localeCompare(kb);
  });

  function fillSelect(id, current) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = (current || '').trim() || (sel.value || '').trim();
    // Clear options
    while (sel.firstChild) sel.removeChild(sel.firstChild);

    for (const p of arr) {
      // Skip the placeholder marker "/dev/serial/by-id/" we added above
      if (p === '/dev/serial/by-id/') continue;
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      sel.appendChild(opt);
    }

    // Manual entry option
    const manual = document.createElement('option');
    manual.value = '__manual__';
    manual.textContent = 'Manuell eingeben…';
    sel.appendChild(manual);

    // Restore selection
    if (prev) {
      // If prev is not in list (e.g. custom), add it and select it
      if (![...sel.options].some(o => o.value === prev)) {
        const opt = document.createElement('option');
        opt.value = prev;
        opt.textContent = prev;
        sel.insertBefore(opt, sel.firstChild);
      }
      sel.value = prev;
    } else {
      // Select first real port if available
      const first = [...sel.options].find(o => o.value && o.value !== '__manual__');
      if (first) sel.value = first.value;
    }
  }

  fillSelect('mb_path', curMb);
  fillSelect('mbus_path', curMbus);
}

function updateSerialPortsStatus(count, ok) {
  const txt = (typeof count === 'number' && count >= 0)
    ? `(${count} Ports gefunden)`
    : (ok ? '(Ports geladen)' : '(Ports nicht verfügbar)');

  $('.serialPortsStatus').text(' ' + txt);
}

function refreshSerialPorts(force) {
  const now = Date.now();
  if (!force && (now - serialPortsLastFetchMs) < 2500) {
    // Just re-apply cached list
    setSerialPortsDatalist(serialPortsCache);
    updateSerialPortsStatus(serialPortsCache.length, true);
    return;
  }
  if (serialPortsFetchInFlight) return;
  serialPortsFetchInFlight = true;

  // If adapter instance is not running, sendTo may fail -> we keep fallback list.
  try {
    if (typeof sendTo !== 'function') {
      serialPortsFetchInFlight = false;
      setSerialPortsDatalist(serialPortsCache);
      updateSerialPortsStatus(null, false);
      return;
    }

    sendTo(null, 'listSerialPorts', {}, (res) => {
      serialPortsFetchInFlight = false;
      const ports = normalizeSerialPortsResponse(res);
      serialPortsCache = ports;
      serialPortsLastFetchMs = Date.now();

      setSerialPortsDatalist(ports);
      updateSerialPortsStatus(ports.length, true);

      // Auto-select a sensible default for new devices (only if user didn't set anything)
      const cur = ($('#mb_path').val() || '').trim();
      if (editIndex < 0 && (!cur || cur === '/dev/com2')) {
        const preferred = ports.find(p => p.startsWith('/dev/serial/by-id/'))
          || ports.find(p => p === '/dev/ttyUSB0')
          || ports.find(p => p.startsWith('/dev/ttyUSB'))
          || ports.find(p => p.startsWith('/dev/'))
          || ports[0];
        if (preferred) $('#mb_path').val(preferred);
      }

      const curMbus = ($('#mbus_path').val() || '').trim();
      if (editIndex < 0 && !curMbus) {
        const preferredMbus = ports.find(p => p.startsWith('/dev/serial/by-id/'))
          || ports.find(p => p === '/dev/ttyUSB0')
          || ports.find(p => p.startsWith('/dev/ttyUSB'))
          || ports.find(p => p.startsWith('/dev/'))
          || ports[0];
        if (preferredMbus) $('#mbus_path').val(preferredMbus);
      }

      updateTextFields();
    });
  } catch (e) {
    serialPortsFetchInFlight = false;
    setSerialPortsDatalist(serialPortsCache);
    updateSerialPortsStatus(null, false);
  }
}

function startSerialPortsAutoRefresh() {
  stopSerialPortsAutoRefresh();
  // Pull-based hotplug detection: refresh list regularly while modal is open.
  serialPortsTimer = setInterval(() => refreshSerialPorts(false), 5000);
}

function stopSerialPortsAutoRefresh() {
  if (serialPortsTimer) {
    clearInterval(serialPortsTimer);
    serialPortsTimer = null;
  }
}

function categoryLabel(cat) {
  const c = (cat || '').toString();
  switch (c) {
    case 'EVCS': return 'Wallbox / Ladestation (EVCS)';
    case 'METER': return 'Zähler / Meter (METER)';
    case 'ESS': return 'Energiespeicher (ESS)';
    case 'PV_INVERTER': return 'PV-Wechselrichter (PV_INVERTER)';
    case 'BATTERY': return 'Batterie (BATTERY)';
    case 'BATTERY_INVERTER': return 'Batteriewechselrichter (BATTERY_INVERTER)';
    case 'HEAT': return 'Heizung / Heizstab (HEAT)';
    case 'EVSE': return 'EVSE / EVSE Controller (EVSE)';
    case 'IO': return 'I/O (IO)';
    case 'GENERIC': return 'Allgemein (GENERIC)';
    default: return c;
  }
}

function idPrefixForCategory(cat) {
  switch ((cat || '').toString()) {
    case 'EVCS': return 'evcs';
    case 'METER': return 'meter';
    case 'ESS': return 'ess';
    case 'PV_INVERTER': return 'pv';
    case 'BATTERY': return 'battery';
    case 'BATTERY_INVERTER': return 'batinv';
    case 'HEAT': return 'heat';
    case 'EVSE': return 'evse';
    case 'IO': return 'io';
    default:
      return (cat || 'dev').toString().toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 6) || 'dev';
  }
}

function suggestDeviceId(cat) {
  const prefix = idPrefixForCategory(cat);
  const used = new Set((devices || []).map(d => (d && d.id ? String(d.id) : '')));
  for (let i = 1; i < 1000; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}${Date.now()}`;
}

function suggestDeviceName(templateId) {
  const tpl = templatesById[templateId];
  if (!tpl) return '';
  const parts = [tpl.manufacturer, tpl.model, tpl.name].filter(Boolean);
  return parts.join(' ').trim() || tpl.id || '';
}

function hasMaterialize() {
  return typeof M !== 'undefined' && M && typeof M.Modal !== 'undefined';
}

function hasFormSelect() {
  return !!($.fn && $.fn.formSelect);
}

function updateTextFields() {
  if (hasMaterialize() && typeof M.updateTextFields === 'function') {
    try { M.updateTextFields(); } catch (e) { /* ignore */ }
  }
}

function toast(msg) {
  const safe = (msg || '').toString();
  if (hasMaterialize() && typeof M.toast === 'function') {
    try { M.toast({ html: escapeHtml(safe) }); return; } catch (e) { /* ignore */ }
  }
  // fallback
  try { alert(safe); } catch (e) { /* ignore */ }
}

function escapeHtml(str) {
  return (str || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { document.body.removeChild(a); } catch (e) { /* ignore */ }
    try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
  }, 0);
}

function exportDevicesJsonToFile() {
  const text = JSON.stringify(devices || [], null, 2);
  downloadTextFile('nexowatt-devices.devices.json', text, 'application/json');
}

function importDevicesJsonFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const txt = (reader.result || '').toString();
    const parsed = safeJsonParse(txt, null);
    if (!Array.isArray(parsed)) {
      toast('Ungültige JSON-Datei: erwartet wird ein Array von Geräten.');
      return;
    }
    devices = parsed;
    renderDevicesTable();
    updateJsonPreview();
    setChanged(true);
    toast(`Import ok: ${devices.length} Geräte übernommen.`);
  };
  reader.onerror = () => toast('Fehler beim Lesen der JSON-Datei.');
  reader.readAsText(file);
}

function setChanged(changed) {
  if (typeof onChangeGlobal === 'function') {
    onChangeGlobal(changed);
  }
}

function refreshSelect($sel) {
  if (!$sel || !$sel.length) return;
  // We use native selects (browser-default) for maximum compatibility.
  // Never initialize Materialize formSelect on those, otherwise it hides the element.
  if ($sel.hasClass('browser-default')) return;
  if (hasFormSelect()) {
    try { $sel.formSelect(); } catch (e) { /* ignore */ }
  }
}

function openModal() {
  const el = document.getElementById('modalDevice');
  if (hasMaterialize()) {
    try {
      const inst = M.Modal.getInstance(el) || M.Modal.init(el, { dismissible: false });
      inst.open();
      startSerialPortsAutoRefresh();
      return;
    } catch (e) {
      console.warn('Materialize modal open failed, falling back:', e);
    }
  }

  // fallback
  $('#modalDevice').addClass('nexo-fallback nexo-open');
  $('#nexoBackdrop').addClass('nexo-open').show();
  startSerialPortsAutoRefresh();
}

function closeModal() {
  const el = document.getElementById('modalDevice');
  if (hasMaterialize()) {
    try {
      const inst = M.Modal.getInstance(el);
      if (inst) inst.close();
      stopSerialPortsAutoRefresh();
      return;
    } catch (e) {
      // ignore and fall back
    }
  }
  $('#modalDevice').removeClass('nexo-open');
  $('#nexoBackdrop').removeClass('nexo-open').hide();
  stopSerialPortsAutoRefresh();
}

function loadTemplates() {
  return new Promise((resolve, reject) => {
    if (templatesData) return resolve(templatesData);

    // Cache-busting is important because Admin often keeps old adapter assets in browser cache.
    $.getJSON(`templates.json?_=${Date.now()}`)
      .done((data) => {
        templatesData = data || {};
        templatesById = {};
        manufacturersByCategory = {};
        templatesByCatManu = {};

        const tpls = Array.isArray(templatesData.templates) ? templatesData.templates : [];
        tpls.forEach((t) => {
          if (!t || !t.id) return;
          templatesById[t.id] = t;
          const cat = t.category || 'OTHER';
          const manu = t.manufacturer || 'Unknown';

          manufacturersByCategory[cat] = manufacturersByCategory[cat] || new Set();
          manufacturersByCategory[cat].add(manu);

          templatesByCatManu[cat] = templatesByCatManu[cat] || {};
          templatesByCatManu[cat][manu] = templatesByCatManu[cat][manu] || [];
          templatesByCatManu[cat][manu].push(t);
        });

        // Prefer the most common categories first for usability.
        const preferredOrder = ['EVCS', 'METER', 'ESS', 'PV_INVERTER', 'BATTERY', 'BATTERY_INVERTER', 'HEAT', 'IO', 'EVSE', 'GENERIC'];
        categories = Object.keys(manufacturersByCategory).sort((a, b) => {
          const ia = preferredOrder.indexOf(a);
          const ib = preferredOrder.indexOf(b);
          const wa = ia >= 0 ? ia : 999;
          const wb = ib >= 0 ? ib : 999;
          if (wa !== wb) return wa - wb;
          return (a || '').localeCompare(b || '');
        });

        // Convert Sets to arrays
        Object.keys(manufacturersByCategory).forEach((cat) => {
          manufacturersByCategory[cat] = Array.from(manufacturersByCategory[cat]).sort((a, b) => (a || '').localeCompare(b || ''));
        });

        // UI hint: show how many driver templates were loaded.
        try { $('#tplCount').text(String(tpls.length)); } catch (e) { /* ignore */ }

        resolve(templatesData);
      })
      .fail((xhr, status, err) => {
        console.error('Failed to load templates.json', status, err);
        try { $('#tplCount').text('0'); } catch (e) { /* ignore */ }
        reject(err || new Error('Failed to load templates.json'));
      });
  });
}

function summarizeConnection(d) {
  const c = d.connection || {};
  const hb = (d && d.heartbeatTimeoutMs !== undefined && d.heartbeatTimeoutMs !== null) ? Number(d.heartbeatTimeoutMs) : NaN;
  const hbTxt = (Number.isFinite(hb) && hb > 0) ? `, hb ${Math.trunc(hb)}ms` : '';
  if (d.protocol === 'modbusTcp') {
    return `${c.host || ''}:${c.port || 502} (unit ${c.unitId ?? 1}${hbTxt})`;
  }
  if (d.protocol === 'kostalTcp') {
    return `${c.host || ''}:${c.port || 81} (unit ${c.unitId ?? 1}${hbTxt})`;
  }
  if (d.protocol === 'kostalRs485') {
    return `${c.path || ''} @${c.baudRate || 19200} (addr ${c.unitId ?? 255}${hbTxt})`;
  }
  if (d.protocol === 'modbusRtu' || d.protocol === 'modbusAscii') {
    return `${c.path || ''} @${c.baudRate || 9600} (unit ${c.unitId ?? 1}${hbTxt})`;
  }
  if (d.protocol === 'mbus') {
    return `${c.path || ''} @${c.baudRate || 2400} (addr ${c.unitId ?? 1}${hbTxt})`;
  }
  if (d.protocol === 'mqtt') {
    return `${c.url || ''}${hbTxt ? (' (' + hbTxt.slice(2) + ')') : ''}`;
  }
  if (d.protocol === 'canbus') {
    return `${c.interface || c.iface || c.canInterface || 'can0'}${hbTxt ? (' (' + hbTxt.slice(2) + ')') : ''}`;
  }
  if (d.protocol === 'http') {
    return `${c.baseUrl || ''}${hbTxt ? (' (' + hbTxt.slice(2) + ')') : ''}`;
  }
  if (d.protocol === 'udp') {
    return `${c.host || ''}:${c.port || 7090}${hbTxt ? (' (' + hbTxt.slice(2) + ')') : ''}`;
  }
  return '';
}

function renderDevicesTable() {
  const tbody = $('#devicesTable tbody');
  tbody.empty();

  if (!devices || !devices.length) {
    $('#noDevicesHint').show();
    return;
  }
  $('#noDevicesHint').hide();

  devices.forEach((d, idx) => {
    const tpl = templatesById[d.templateId];
    const manufacturer = tpl ? (tpl.manufacturer || '') : '';
    const tplName = tpl ? (tpl.name || tpl.id) : (d.templateId || '');

    const row = $(`
      <tr>
        <td>${d.enabled ? '✓' : ''}</td>
        <td><code>${escapeHtml(d.id)}</code></td>
        <td>${escapeHtml(d.name || '')}</td>
        <td>${escapeHtml(d.category || '')}</td>
        <td>${escapeHtml(manufacturer)}</td>
        <td>${escapeHtml(tplName)}</td>
        <td>${escapeHtml(d.protocol || '')}</td>
        <td class="actions">
          <a href="#!" class="btn-small waves-effect" data-action="edit" data-idx="${idx}">${escapeHtml('Gerät bearbeiten')}</a>
          <a href="#!" class="btn-small red waves-effect" data-action="delete" data-idx="${idx}">${escapeHtml('Löschen')}</a>
        </td>
      </tr>
    `);

    tbody.append(row);
  });
}

function fillCategorySelect() {
  const sel = $('#dev_category');
  sel.empty();
  categories.forEach((cat) => sel.append(`<option value="${escapeHtml(cat)}">${escapeHtml(categoryLabel(cat))}</option>`));
  refreshSelect(sel);
}

function fillManufacturerSelect(cat) {
  const sel = $('#dev_manufacturer');
  sel.empty();
  const manus = manufacturersByCategory[cat] || [];
  manus.forEach((m) => sel.append(`<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`));
  refreshSelect(sel);
}

function fillTemplateSelect(cat, manu) {
  const sel = $('#dev_template');
  sel.empty();
  const tpls = (templatesByCatManu[cat] && templatesByCatManu[cat][manu]) ? templatesByCatManu[cat][manu] : [];
  tpls
    .slice()
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    .forEach((t) => sel.append(`<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`));
  refreshSelect(sel);
}

function fillProtocolSelect(templateId, currentProtocol) {
  const sel = $('#dev_protocol');
  sel.empty();

  const tpl = templatesById[templateId];
  const protos = (tpl && Array.isArray(tpl.protocols)) ? tpl.protocols : [];

  protos.forEach((p) => sel.append(`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`));
  refreshSelect(sel);

  if (currentProtocol && protos.includes(currentProtocol)) {
    sel.val(currentProtocol);
  } else if (protos.length) {
    sel.val(protos[0]);
  }
  refreshSelect(sel);
}

function showConnBlock(protocol) {
  $('.nexo-conn-block').hide();
  if (protocol === 'modbusTcp') $('#conn_modbusTcp').show();
  if (protocol === 'kostalTcp') $('#conn_kostalTcp').show();
  if (protocol === 'modbusRtu' || protocol === 'modbusAscii' || protocol === 'kostalRs485') $('#conn_modbusRtu').show();
  if (protocol === 'mbus') $('#conn_mbus').show();
  if (protocol === 'mqtt') $('#conn_mqtt').show();
  if (protocol === 'canbus') $('#conn_canbus').show();
  if (protocol === 'onewire') $('#conn_onewire').show();
  if (protocol === 'http') $('#conn_http').show();
  if (protocol === 'udp') $('#conn_udp').show();
  if (protocol === 'speedwire') $('#conn_speedwire').show();

  // Refresh serial ports list whenever a serial-based protocol is selected.
  if (protocol === 'modbusRtu' || protocol === 'modbusAscii' || protocol === 'kostalRs485' || protocol === 'mbus') {
    refreshSerialPorts(false);
  }
}

function summarizeDatapoint(dp) {
  const src = dp.source || {};
  const kind = src.kind || '';
  if (kind === 'modbus') {
    const r = src.read || {};
    const w = src.write || {};
    const dt = (r.dataType || w.dataType || src.dataType || dp.type || '').toString();
    const sf = (src.scaleFactor !== undefined && src.scaleFactor !== null) ? ` sf=${src.scaleFactor}` : '';
    const rTxt = (r.fc != null && r.address != null) ? `R:FC${r.fc}@${r.address}(${r.length || 1})` : '';
    const wTxt = (w.fc != null && w.address != null) ? ` W:FC${w.fc}@${w.address}(${w.length || 1})` : '';
    return `${rTxt}${wTxt} ${dt}${sf}`.trim();
  }
  if (kind === 'mqtt') {
    return `topic: ${src.topic || ''}`.trim();
  }
  if (kind === 'canbus') {
    if (src.computed) return `computed: ${src.computed}`;
    const id = (src.canId !== undefined && src.canId !== null) ? src.canId : '';
    const off = (src.byteOffset !== undefined && src.byteOffset !== null) ? ` off=${src.byteOffset}` : '';
    const len = (src.byteLength !== undefined && src.byteLength !== null) ? ` len=${src.byteLength}` : '';
    const dt = (src.dataType || '').toString();
    return `id: ${id}${off}${len} ${dt}`.trim();
  }
  if (kind === 'onewire') {
    const sid = src.sensorId || '';
    const f = src.file || 'w1_slave';
    const p = src.parser || 'ds18b20';
    return `sensor: ${sid || '(cfg)'} file: ${f} parser: ${p}`.trim();
  }
  if (kind === 'mbus') {
    return `field: ${src.field || ''}`.trim();
  }
  if (kind === 'http') {
    return `${(src.method || 'GET').toUpperCase()} ${src.path || ''} ${src.jsonPath ? ('-> ' + src.jsonPath) : ''}`.trim();
  }
  if (kind === 'udp') {
    const r = src.read || {};
    const w = src.write || {};
    const rTxt = r.cmd ? `cmd: ${r.cmd}${r.jsonPath ? (' -> ' + r.jsonPath) : ''}` : '';
    const wTxt = w.cmdTemplate ? ` set: ${w.cmdTemplate}` : (w.cmd ? ` set: ${w.cmd}` : '');
    return `${rTxt}${wTxt}`.trim();
  }
  if (kind === 'speedwire') {
    if (src.field) return `field: ${src.field}`;
    if (src.computed) return `computed: ${src.computed}`;
    const o = src.obis || {};
    const parts = [];
    if (o.b !== undefined && o.b !== null) parts.push(`b=${o.b}`);
    if (o.c !== undefined && o.c !== null) parts.push(`c=${o.c}`);
    if (o.d !== undefined && o.d !== null) parts.push(`d=${o.d}`);
    if (o.e !== undefined && o.e !== null) parts.push(`e=${o.e}`);
    return parts.length ? `OBIS ${parts.join(', ')}` : 'speedwire';
  }
  return kind;
}

function renderDatapoints(templateId) {
  const tpl = templatesById[templateId];
  const tbody = $('#dpBody');
  tbody.empty();

  if (!tpl || !Array.isArray(tpl.datapoints)) return;

  tpl.datapoints.forEach((dp) => {
    const row = $(`
      <tr>
        <td><code>${escapeHtml(dp.id)}</code></td>
        <td>${escapeHtml(dp.name || '')}</td>
        <td>${escapeHtml(dp.type || '')}</td>
        <td>${escapeHtml(dp.rw || 'ro')}</td>
        <td>${escapeHtml(summarizeDatapoint(dp))}</td>
      </tr>
    `);
    tbody.append(row);
  });
}

function openDeviceModal(device, idx) {
  editIndex = (typeof idx === 'number') ? idx : -1;
  $('#modalTitle').text(editIndex >= 0 ? 'Gerät bearbeiten' : 'Gerät hinzufügen');

  $('#dev_id').val(device.id || '');
  $('#dev_name').val(device.name || '');
  $('#dev_enabled').prop('checked', device.enabled !== false);
  $('#dev_poll').val(device.pollIntervalMs || '');
  $('#dev_hbTimeout').val(device.heartbeatTimeoutMs || '');

  // category/manufacturer/template
  const cat = device.category || categories[0] || 'GENERIC';
  $('#dev_category').val(cat);
  refreshSelect($('#dev_category'));

  fillManufacturerSelect(cat);
  const manuList = manufacturersByCategory[cat] || [];
  const manu = device.manufacturer || (manuList[0] || '');
  $('#dev_manufacturer').val(manu);
  refreshSelect($('#dev_manufacturer'));

  fillTemplateSelect(cat, manu);
  const tplId = device.templateId || ($('#dev_template option:first').val() || '');
  $('#dev_template').val(tplId);
  refreshSelect($('#dev_template'));

  fillProtocolSelect(tplId, device.protocol);

  const proto = $('#dev_protocol').val();
  showConnBlock(proto);
  renderDatapoints(tplId);

  // Auto-fill convenience for new devices: ID + default name
  if (editIndex < 0) {
    const curId = ($('#dev_id').val() || '').trim();
    if (!curId) {
      lastSuggestedId = suggestDeviceId(cat);
      $('#dev_id').val(lastSuggestedId);
    } else {
      lastSuggestedId = curId;
    }
    const curName = ($('#dev_name').val() || '').trim();
    if (!curName) {
      const suggested = suggestDeviceName(tplId);
      if (suggested) {
        lastSuggestedName = suggested;
        $('#dev_name').val(suggested);
      }
    } else {
      lastSuggestedName = curName;
    }
  } else {
    lastSuggestedId = ($('#dev_id').val() || '').trim();
    lastSuggestedName = ($('#dev_name').val() || '').trim();
  }

  // connection defaults
  const c = device.connection || {};

  // TCP
  $('#mb_host').val(c.host || '');
  $('#mb_port').val(c.port ?? 502);
  $('#mb_unitId').val(c.unitId ?? 1);
  $('#mb_timeout').val(c.timeoutMs ?? '');
  $('#mb_addrOffset').val(c.addressOffset ?? 0);
  $('#mb_wordOrder').val(c.wordOrder || 'be');

  // Kostal (RJ45/TCP)
  $('#ko_host').val(c.host || '');
  $('#ko_port').val(c.port ?? 81);
  $('#ko_unitId').val(c.unitId ?? 1);
  $('#ko_timeout').val(c.timeoutMs ?? '');
  $('#mb_byteOrder').val(c.byteOrder || 'be');
  $('#mb_writePass').val(c.writePassword || '');
  refreshSelect($('#mb_wordOrder'));
  refreshSelect($('#mb_byteOrder'));

  // RTU
  // Leave empty for new devices; we auto-suggest a real detected port via refreshSerialPorts().
  $('#mb_path').val(c.path || '');
  $('#mb_baud').val(c.baudRate ?? 9600);
  $('#mb_parity').val(c.parity || 'none');
  $('#mb_databits').val(c.dataBits ?? 8);
  $('#mb_stopbits').val(c.stopBits ?? 1);
  $('#mb_unitId_rtu').val(c.unitId ?? 1);
  $('#mb_timeout_rtu').val(c.timeoutMs ?? '');
  $('#mb_addrOffset_rtu').val(c.addressOffset ?? 0);
  $('#mb_wordOrder_rtu').val(c.wordOrder || 'be');
  $('#mb_byteOrder_rtu').val(c.byteOrder || 'be');
  $('#mb_writePass_rtu').val(c.writePassword || '');
  refreshSelect($('#mb_parity'));
  refreshSelect($('#mb_wordOrder_rtu'));
  refreshSelect($('#mb_byteOrder_rtu'));

  // Kostal RS485 defaults (PIKO): 19200 8N1, default address 255
  if (proto === 'kostalRs485') {
    if (c.baudRate === undefined || c.baudRate === null || c.baudRate === '') $('#mb_baud').val(19200);
    if (c.parity === undefined || c.parity === null || c.parity === '') $('#mb_parity').val('none');
    if (c.dataBits === undefined || c.dataBits === null || c.dataBits === '') $('#mb_databits').val(8);
    if (c.stopBits === undefined || c.stopBits === null || c.stopBits === '') $('#mb_stopbits').val(1);
    if (c.unitId === undefined || c.unitId === null || c.unitId === '') $('#mb_unitId_rtu').val(255);
    if (c.timeoutMs === undefined || c.timeoutMs === null || c.timeoutMs === '') $('#mb_timeout_rtu').val(2000);
    refreshSelect($('#mb_parity'));
  }

  // M-Bus (wired)
  $('#mbus_path').val(c.path || '/dev/ttyUSB0');
  $('#mbus_baud').val(c.baudRate ?? 2400);
  $('#mbus_parity').val(c.parity || 'even');
  $('#mbus_databits').val(c.dataBits ?? 8);
  $('#mbus_stopbits').val(c.stopBits ?? 1);
  $('#mbus_unitId').val(c.unitId ?? 1);
  $('#mbus_timeout').val(c.timeoutMs ?? '');
  $('#mbus_sendNke').prop('checked', c.sendNke !== false);
  refreshSelect($('#mbus_parity'));

  // MQTT
  $('#mqtt_url').val(c.url || '');
  $('#mqtt_user').val(c.username || '');
  $('#mqtt_pass').val(c.password || '');

  // CANbus
  $('#can_iface').val(c.interface || c.iface || c.canInterface || 'can0');
  $('#can_candumpArgs').val(c.candumpArgs || '');
  $('#can_candumpPath').val(c.candumpPath || 'candump');
  $('#can_cansendPath').val(c.cansendPath || 'cansend');

  // 1-Wire
  $('#ow_basePath').val(c.basePath || '/sys/bus/w1/devices');
  $('#ow_sensorId').val(c.sensorId || '');
  $('#ow_file').val(c.file || 'w1_slave');
  $('#ow_parser').val(c.parser || 'ds18b20');

  // HTTP
  $('#http_baseUrl').val(c.baseUrl || '');
  $('#http_user').val(c.username || '');
  $('#http_pass').val(c.password || '');
  $('#http_meterId').val(c.meterId || '');
  $('#http_insecureTls').prop('checked', !!c.insecureTls);


  // UDP
  $('#udp_host').val(c.host || '');
  $('#udp_port').val(c.port ?? 7090);
  $('#udp_timeout').val(c.timeoutMs ?? '');
  $('#udp_pause').val(c.commandPauseMs ?? 0);

  // Speedwire (UDP multicast)
  $('#sw_filterHost').val(c.filterHost || c.host || '');
  $('#sw_multicastGroup').val(c.multicastGroup || '239.12.255.254');
  $('#sw_port').val(c.port ?? 9522);
  $('#sw_interface').val(c.interfaceAddress || '');
  // Default increased to 30000ms to reduce false positives on networks where multicast
  // forwarding can be bursty (IGMP snooping/querier, WiFi multicast filtering, VMs).
  $('#sw_stale').val(c.staleTimeoutMs ?? 30000);

  // Populate serial port datalist from the host (supports hotplug).
  refreshSerialPorts(true);

  updateTextFields();
  openModal();
}

function collectDeviceFromModal() {
  const tplId = $('#dev_template').val();
  const tpl = templatesById[tplId];

  const d = {
    id: ($('#dev_id').val() || '').trim(),
    name: ($('#dev_name').val() || '').trim(),
    enabled: $('#dev_enabled').is(':checked'),
    category: $('#dev_category').val(),
    manufacturer: $('#dev_manufacturer').val(),
    templateId: tplId,
    protocol: $('#dev_protocol').val(),
    pollIntervalMs: ($('#dev_poll').val() || '').trim() ? parseInt($('#dev_poll').val(), 10) : undefined,
    heartbeatTimeoutMs: ($('#dev_hbTimeout').val() || '').trim() ? parseInt($('#dev_hbTimeout').val(), 10) : undefined,
    connection: {}
  };

  // Normalize heartbeat timeout (optional)
  if (!Number.isFinite(Number(d.heartbeatTimeoutMs)) || Number(d.heartbeatTimeoutMs) <= 0) {
    delete d.heartbeatTimeoutMs;
  } else {
    d.heartbeatTimeoutMs = Math.trunc(Number(d.heartbeatTimeoutMs));
  }

  if (tpl && Array.isArray(tpl.protocols) && d.protocol && !tpl.protocols.includes(d.protocol)) {
    throw new Error('Protokoll wird vom Template nicht unterstützt');
  }

  // Connection fields
  if (d.protocol === 'modbusTcp') {
    d.connection.host = ($('#mb_host').val() || '').trim();
    d.connection.port = parseInt($('#mb_port').val(), 10) || 502;
    d.connection.unitId = parseInt($('#mb_unitId').val(), 10) || 1;

    const t = parseInt($('#mb_timeout').val(), 10);
    if (!isNaN(t)) d.connection.timeoutMs = t;

    const o = parseInt($('#mb_addrOffset').val(), 10);
    if (!isNaN(o)) d.connection.addressOffset = o;

    d.connection.wordOrder = $('#mb_wordOrder').val() || 'be';
    d.connection.byteOrder = $('#mb_byteOrder').val() || 'be';
    d.connection.writePassword = ($('#mb_writePass').val() || '').trim() || undefined;
  } else if (d.protocol === 'kostalTcp') {
    d.connection.host = ($('#ko_host').val() || '').trim();
    d.connection.port = parseInt($('#ko_port').val(), 10) || 81;
    d.connection.unitId = parseInt($('#ko_unitId').val(), 10) || 1;
    d.connection.timeoutMs = parseInt($('#ko_timeout').val(), 10) || 2000;
  } else if (d.protocol === 'modbusRtu' || d.protocol === 'modbusAscii' || d.protocol === 'kostalRs485') {
    d.connection.path = ($('#mb_path').val() || '').trim();
    const br = parseInt($('#mb_baud').val(), 10);
    d.connection.baudRate = (!isNaN(br) ? br : (d.protocol === 'kostalRs485' ? 19200 : 9600));
    d.connection.parity = $('#mb_parity').val() || 'none';
    d.connection.dataBits = parseInt($('#mb_databits').val(), 10) || 8;
    d.connection.stopBits = parseInt($('#mb_stopbits').val(), 10) || 1;

    const uid = parseInt($('#mb_unitId_rtu').val(), 10);
    d.connection.unitId = (!isNaN(uid) ? uid : (d.protocol === 'kostalRs485' ? 255 : 1));

    const t = parseInt($('#mb_timeout_rtu').val(), 10);
    if (!isNaN(t)) d.connection.timeoutMs = t;

    const o = parseInt($('#mb_addrOffset_rtu').val(), 10);
    if (!isNaN(o)) d.connection.addressOffset = o;

    // These Modbus-specific fields are ignored by non-Modbus serial protocols.
    d.connection.wordOrder = $('#mb_wordOrder_rtu').val() || 'be';
    d.connection.byteOrder = $('#mb_byteOrder_rtu').val() || 'be';
    d.connection.writePassword = ($('#mb_writePass_rtu').val() || '').trim() || undefined;
  } else if (d.protocol === 'mbus') {
    d.connection.path = ($('#mbus_path').val() || '').trim();
    d.connection.baudRate = parseInt($('#mbus_baud').val(), 10) || 2400;
    d.connection.parity = $('#mbus_parity').val() || 'even';
    d.connection.dataBits = parseInt($('#mbus_databits').val(), 10) || 8;
    d.connection.stopBits = parseInt($('#mbus_stopbits').val(), 10) || 1;

    const a = parseInt($('#mbus_unitId').val(), 10);
    d.connection.unitId = isNaN(a) ? 1 : a;

    const t = parseInt($('#mbus_timeout').val(), 10);
    if (!isNaN(t)) d.connection.timeoutMs = t;

    d.connection.sendNke = $('#mbus_sendNke').is(':checked');
  } else if (d.protocol === 'mqtt') {
    d.connection.url = ($('#mqtt_url').val() || '').trim();
    d.connection.username = ($('#mqtt_user').val() || '').trim() || undefined;
    d.connection.password = ($('#mqtt_pass').val() || '').trim() || undefined;
  } else if (d.protocol === 'canbus') {
    d.connection.interface = ($('#can_iface').val() || '').trim() || 'can0';
    d.connection.candumpArgs = ($('#can_candumpArgs').val() || '').trim() || undefined;
    d.connection.candumpPath = ($('#can_candumpPath').val() || '').trim() || 'candump';
    d.connection.cansendPath = ($('#can_cansendPath').val() || '').trim() || 'cansend';
  } else if (d.protocol === 'onewire') {
    d.connection.basePath = ($('#ow_basePath').val() || '').trim() || '/sys/bus/w1/devices';
    d.connection.sensorId = ($('#ow_sensorId').val() || '').trim();
    d.connection.file = ($('#ow_file').val() || '').trim() || 'w1_slave';
    d.connection.parser = ($('#ow_parser').val() || 'ds18b20').trim() || 'ds18b20';
  } else if (d.protocol === 'http') {
    d.connection.baseUrl = ($('#http_baseUrl').val() || '').trim();
    d.connection.username = ($('#http_user').val() || '').trim() || undefined;
    d.connection.password = ($('#http_pass').val() || '').trim() || undefined;
    d.connection.meterId = ($('#http_meterId').val() || '').trim() || undefined;
    if ($('#http_insecureTls').is(':checked')) d.connection.insecureTls = true;
  } else if (d.protocol === 'udp') {
    d.connection.host = ($('#udp_host').val() || '').trim();
    d.connection.port = parseInt($('#udp_port').val(), 10) || 7090;
    const t = parseInt($('#udp_timeout').val(), 10);
    if (!isNaN(t)) d.connection.timeoutMs = t;
    const p = parseInt($('#udp_pause').val(), 10);
    if (!isNaN(p)) d.connection.commandPauseMs = p;
  } else if (d.protocol === 'speedwire') {
    const filterHost = ($('#sw_filterHost').val() || '').trim();
    if (filterHost) {
      d.connection.filterHost = filterHost;
      // Backwards/compat: also expose under host, as many UIs use this field.
      d.connection.host = filterHost;
    }

    d.connection.multicastGroup = ($('#sw_multicastGroup').val() || '').trim() || '239.12.255.254';
    d.connection.port = parseInt($('#sw_port').val(), 10) || 9522;
    const iface = ($('#sw_interface').val() || '').trim();
    if (iface) d.connection.interfaceAddress = iface;

    const st = parseInt($('#sw_stale').val(), 10);
    if (!isNaN(st)) d.connection.staleTimeoutMs = st;
  }

  // minimal validation
  if (!d.id) throw new Error('Geräte-ID fehlt');
  if (!/^[a-zA-Z0-9_\-]+$/.test(d.id)) throw new Error('Ungültige Geräte-ID. Erlaubt: Buchstaben, Zahlen, _ und -');
  if (!d.templateId) throw new Error('Template fehlt');
  if (!d.protocol) throw new Error('Protokoll fehlt');

  if (d.protocol === 'modbusTcp' && !d.connection.host) throw new Error('Modbus TCP Host/IP fehlt');
  if ((d.protocol === 'modbusRtu' || d.protocol === 'modbusAscii') && !d.connection.path) throw new Error('Modbus Serial-Port fehlt');
  if (d.protocol === 'kostalRs485' && !d.connection.path) throw new Error('RS485 Serial-Port fehlt');
  if (d.protocol === 'mbus' && !d.connection.path) throw new Error('M-Bus Serial-Port fehlt');
  if (d.protocol === 'mqtt' && !d.connection.url) throw new Error('MQTT Broker-URL fehlt');
  if (d.protocol === 'canbus' && !d.connection.interface) throw new Error('CAN Interface fehlt (z.B. can0)');
  if (d.protocol === 'onewire' && !d.connection.sensorId) throw new Error('1-Wire Sensor-ID fehlt');
  if (d.protocol === 'http' && !d.connection.baseUrl) throw new Error('HTTP Base-URL fehlt');

  if (d.protocol === 'udp' && !d.connection.host) throw new Error('UDP Host/IP fehlt');

  // Speedwire has sensible defaults; filterHost is optional.

  return d;
}

function updateJsonPreview() {
  const jsonStr = JSON.stringify(devices || [], null, 2);
  $('#devicesJson').val(jsonStr);
  $('#jsonPreview').text(jsonStr);
}

function initEventHandlers() {
  // Serial port refresh (hotplug)
  $(document).on('click', '.btnRefreshSerialPorts', () => refreshSerialPorts(true));

  // Remember previous selection (for cancel on manual entry)
  $(document).on('focus', '#mb_path, #mbus_path', function () {
    try { this.dataset.prev = this.value; } catch (e) { /* ignore */ }
  });

  // Manual entry option for serial ports
  $(document).on('change', '#mb_path, #mbus_path', function () {
    if (this.value !== '__manual__') return;
    const prev = (this.dataset && this.dataset.prev) ? this.dataset.prev : '';
    const hint = (this.id === 'mbus_path')
      ? 'Serial Port Pfad für M-Bus (z.B. /dev/ttyUSB0 oder /dev/serial/by-id/...)'
      : 'Serial Port Pfad für Modbus/RS485 (z.B. /dev/ttyUSB0 oder /dev/com2 oder /dev/serial/by-id/...)';

    const entered = (window.prompt(hint, prev && prev !== '__manual__' ? prev : '') || '').trim();
    if (!entered) {
      // Cancel -> restore previous
      this.value = prev && prev !== '__manual__' ? prev : (this.options[0] ? this.options[0].value : '');
      return;
    }

    // Add as option if not present
    const exists = [...this.options].some(o => o.value === entered);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = entered;
      opt.textContent = entered;
      // Insert before manual option
      const manualOpt = [...this.options].find(o => o.value === '__manual__');
      if (manualOpt) this.insertBefore(opt, manualOpt);
      else this.appendChild(opt);
    }
    this.value = entered;
  });

  // JSON preview toggle
  $('#btnShowJson').on('click', () => {
    const shown = $('#jsonPreview').is(':visible');
    if (shown) {
      $('#jsonPreview').hide();
    } else {
      updateJsonPreview();
      $('#jsonPreview').show();
    }
  });

  // Add
  $('#btnAddDevice').on('click', () => {
    openDeviceModal({ enabled: true }, -1);
  });

  // JSON import/export (devices)
  $('#btnExportDevices').on('click', () => exportDevicesJsonToFile());
  $('#btnImportDevices').on('click', () => {
    try { $('#importJsonFile').val(''); } catch (e) { /* ignore */ }
    $('#importJsonFile').trigger('click');
  });
  $('#importJsonFile').on('change', (ev) => {
    const file = ev && ev.target && ev.target.files ? ev.target.files[0] : null;
    importDevicesJsonFromFile(file);
  });

  // Table actions
  $('#devicesTable').on('click', 'a[data-action]', (ev) => {
    const action = $(ev.currentTarget).data('action');
    const idx = parseInt($(ev.currentTarget).data('idx'), 10);

    if (action === 'edit') {
      openDeviceModal(devices[idx], idx);
    } else if (action === 'delete') {
      const d = devices[idx];
      if (confirm(`Gerät löschen: ${d.id}?`)) {
        devices.splice(idx, 1);
        renderDevicesTable();
        updateJsonPreview();
        setChanged(true);
      }
    }
  });

  // Cancel
  $('#btnCancelDevice').on('click', () => closeModal());

  // Backdrop click (fallback)
  $('#nexoBackdrop').on('click', () => closeModal());

  // Modal dependent selects
  $('#dev_category').on('change', () => {
    const cat = $('#dev_category').val();
    fillManufacturerSelect(cat);

    const manu = $('#dev_manufacturer').val();
    fillTemplateSelect(cat, manu);

    const tplId = $('#dev_template').val();
    fillProtocolSelect(tplId);

    showConnBlock($('#dev_protocol').val());
    renderDatapoints(tplId);

    // Keep ID/Name suggestions in sync for new devices
    if (editIndex < 0) {
      const curId = ($('#dev_id').val() || '').trim();
      if (!curId || curId === lastSuggestedId) {
        lastSuggestedId = suggestDeviceId(cat);
        $('#dev_id').val(lastSuggestedId);
      }
      const curName = ($('#dev_name').val() || '').trim();
      if (!curName || curName === lastSuggestedName) {
        lastSuggestedName = suggestDeviceName(tplId);
        if (lastSuggestedName) $('#dev_name').val(lastSuggestedName);
      }
    }

    updateTextFields();
  });

  $('#dev_manufacturer').on('change', () => {
    const cat = $('#dev_category').val();
    const manu = $('#dev_manufacturer').val();
    fillTemplateSelect(cat, manu);

    const tplId = $('#dev_template').val();
    fillProtocolSelect(tplId);

    showConnBlock($('#dev_protocol').val());
    renderDatapoints(tplId);

    if (editIndex < 0) {
      const curName = ($('#dev_name').val() || '').trim();
      if (!curName || curName === lastSuggestedName) {
        lastSuggestedName = suggestDeviceName(tplId);
        if (lastSuggestedName) $('#dev_name').val(lastSuggestedName);
      }
    }

    updateTextFields();
  });

  $('#dev_template').on('change', () => {
    const tplId = $('#dev_template').val();
    fillProtocolSelect(tplId);

    showConnBlock($('#dev_protocol').val());
    renderDatapoints(tplId);

    if (editIndex < 0) {
      const curName = ($('#dev_name').val() || '').trim();
      if (!curName || curName === lastSuggestedName) {
        lastSuggestedName = suggestDeviceName(tplId);
        if (lastSuggestedName) $('#dev_name').val(lastSuggestedName);
      }
    }

    updateTextFields();
  });

  $('#dev_protocol').on('change', () => {
    showConnBlock($('#dev_protocol').val());
  });

  // Save device
  $('#btnSaveDevice').on('click', () => {
    try {
      const d = collectDeviceFromModal();

      // uniqueness check
      const existsIdx = devices.findIndex((x, i) => x.id === d.id && i !== editIndex);
      if (existsIdx >= 0) {
        throw new Error('Geräte-ID existiert bereits');
      }

      if (editIndex >= 0) {
        devices[editIndex] = d;
      } else {
        devices.push(d);
      }

      devices.sort((a, b) => (a.id || '').localeCompare(b.id || ''));

      renderDevicesTable();
      updateJsonPreview();
      setChanged(true);

      closeModal();
    } catch (e) {
      toast('Fehler: ' + (e.message || e.toString()));
    }
  });
}

function initUIOnce() {
  if (uiInitialized) return;
  uiInitialized = true;

  // Init modals/selects if available, but never block UI if not.
  if (hasMaterialize()) {
    try {
      const elems = document.querySelectorAll('.modal');
      M.Modal.init(elems, { dismissible: false });
      try {
        const tabs = document.querySelectorAll('.tabs');
        if (tabs && tabs.length) M.Tabs.init(tabs, {});
      } catch (e2) {
        console.warn('Materialize tabs init failed:', e2);
      }
    } catch (e) {
      console.warn('Materialize modal init failed:', e);
      $('#modalDevice').addClass('nexo-fallback');
    }
  } else {
    $('#modalDevice').addClass('nexo-fallback');
  }

  // We intentionally do NOT initialize Materialize "formSelect" for browser-default selects.
  // This avoids invisible/empty selects in some Admin setups.
  if (hasFormSelect()) {
    try { $('select').not('.browser-default').formSelect(); } catch (e) { /* ignore */ }
  }

  initEventHandlers();
}

function applySettingsToUI(settings) {
  $('#pollIntervalMs').val(settings.pollIntervalMs ?? 5000);
  $('#modbusTimeoutMs').val(settings.modbusTimeoutMs ?? 2000);
  $('#registerAddressOffset').val(settings.registerAddressOffset ?? 0);

  const parsed = Array.isArray(settings.devices) ? settings.devices : safeJsonParse(settings.devicesJson || '[]', []);
  devices = Array.isArray(parsed) ? parsed : [];

  updateJsonPreview();
  renderDevicesTable();
  updateTextFields();
}

/* ioBroker admin hooks */
function load(settings, onChange) {
  onChangeGlobal = onChange;
  if (!settings) settings = {};

  loadTemplates()
    .then(() => {
      initUIOnce();
      fillCategorySelect();
      applySettingsToUI(settings);
      translateAll();
      onChange(false);
    })
    .catch((e) => {
      console.error(e);
      initUIOnce();
      applySettingsToUI(settings);
      toast('Warnung: Templates konnten nicht geladen werden. Bitte Browser-Cache leeren und erneut öffnen.');
      onChange(false);
    });
}

function save(callback) {
  const obj = {};
  obj.pollIntervalMs = parseInt($('#pollIntervalMs').val(), 10) || 5000;
  obj.modbusTimeoutMs = parseInt($('#modbusTimeoutMs').val(), 10) || 2000;
  obj.registerAddressOffset = parseInt($('#registerAddressOffset').val(), 10) || 0;
  obj.devices = devices || [];
  obj.devicesJson = JSON.stringify(devices || [], null, 2);

  callback(obj);
}
