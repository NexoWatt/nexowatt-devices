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
      return;
    } catch (e) {
      console.warn('Materialize modal open failed, falling back:', e);
    }
  }

  // fallback
  $('#modalDevice').addClass('nexo-fallback nexo-open');
  $('#nexoBackdrop').addClass('nexo-open').show();
}

function closeModal() {
  const el = document.getElementById('modalDevice');
  if (hasMaterialize()) {
    try {
      const inst = M.Modal.getInstance(el);
      if (inst) inst.close();
      return;
    } catch (e) {
      // ignore and fall back
    }
  }
  $('#modalDevice').removeClass('nexo-open');
  $('#nexoBackdrop').removeClass('nexo-open').hide();
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
  if (d.protocol === 'modbusTcp') {
    return `${c.host || ''}:${c.port || 502} (unit ${c.unitId ?? 1})`;
  }
  if (d.protocol === 'modbusRtu' || d.protocol === 'modbusAscii') {
    return `${c.path || ''} @${c.baudRate || 9600} (unit ${c.unitId ?? 1})`;
  }
  if (d.protocol === 'mqtt') {
    return `${c.url || ''}`;
  }
  if (d.protocol === 'http') {
    return `${c.baseUrl || ''}`;
  }
  if (d.protocol === 'udp') {
    return `${c.host || ''}:${c.port || 7090}`;
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
    const tplName = tpl ? (tpl.name || tpl.id) : (d.templateId || '');

    const connInfo = summarizeConnection(d);

    const row = $(`
      <tr>
        <td>${d.enabled ? '✓' : ''}</td>
        <td><code>${escapeHtml(d.id)}</code></td>
        <td>${escapeHtml(d.name || '')}</td>
        <td>${escapeHtml(d.category || '')}</td>
        <td>${escapeHtml(tplName)}</td>
        <td>${escapeHtml(d.protocol || '')}</td>
        <td>${escapeHtml(connInfo)}</td>
        <td class="actions">
          <a href="#!" class="btn-small waves-effect" data-action="edit" data-idx="${idx}">${escapeHtml('Bearbeiten')}</a>
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
  if (protocol === 'modbusRtu' || protocol === 'modbusAscii') $('#conn_modbusRtu').show();
  if (protocol === 'mqtt') $('#conn_mqtt').show();
  if (protocol === 'http') $('#conn_http').show();
  if (protocol === 'udp') $('#conn_udp').show();
  if (protocol === 'speedwire') $('#conn_speedwire').show();
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
  $('#mb_byteOrder').val(c.byteOrder || 'be');
  $('#mb_writePass').val(c.writePassword || '');
  refreshSelect($('#mb_wordOrder'));
  refreshSelect($('#mb_byteOrder'));

  // RTU
  // Default for ED-IPC3020 RS485: /dev/com2
  $('#mb_path').val(c.path || '/dev/com2');
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

  // MQTT
  $('#mqtt_url').val(c.url || '');
  $('#mqtt_user').val(c.username || '');
  $('#mqtt_pass').val(c.password || '');

  // HTTP
  $('#http_baseUrl').val(c.baseUrl || '');
  $('#http_user').val(c.username || '');
  $('#http_pass').val(c.password || '');


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
  $('#sw_stale').val(c.staleTimeoutMs ?? 8000);

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
    connection: {}
  };

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
  } else if (d.protocol === 'modbusRtu' || d.protocol === 'modbusAscii') {
    d.connection.path = ($('#mb_path').val() || '').trim();
    d.connection.baudRate = parseInt($('#mb_baud').val(), 10) || 9600;
    d.connection.parity = $('#mb_parity').val() || 'none';
    d.connection.dataBits = parseInt($('#mb_databits').val(), 10) || 8;
    d.connection.stopBits = parseInt($('#mb_stopbits').val(), 10) || 1;

    d.connection.unitId = parseInt($('#mb_unitId_rtu').val(), 10) || 1;

    const t = parseInt($('#mb_timeout_rtu').val(), 10);
    if (!isNaN(t)) d.connection.timeoutMs = t;

    const o = parseInt($('#mb_addrOffset_rtu').val(), 10);
    if (!isNaN(o)) d.connection.addressOffset = o;

    d.connection.wordOrder = $('#mb_wordOrder_rtu').val() || 'be';
    d.connection.byteOrder = $('#mb_byteOrder_rtu').val() || 'be';
    d.connection.writePassword = ($('#mb_writePass_rtu').val() || '').trim() || undefined;
  } else if (d.protocol === 'mqtt') {
    d.connection.url = ($('#mqtt_url').val() || '').trim();
    d.connection.username = ($('#mqtt_user').val() || '').trim() || undefined;
    d.connection.password = ($('#mqtt_pass').val() || '').trim() || undefined;
  } else if (d.protocol === 'http') {
    d.connection.baseUrl = ($('#http_baseUrl').val() || '').trim();
    d.connection.username = ($('#http_user').val() || '').trim() || undefined;
    d.connection.password = ($('#http_pass').val() || '').trim() || undefined;
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
  if (d.protocol === 'mqtt' && !d.connection.url) throw new Error('MQTT Broker-URL fehlt');
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

  const parsed = safeJsonParse(settings.devicesJson || '[]', []);
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
  obj.devicesJson = JSON.stringify(devices || [], null, 2);

  callback(obj);
}
