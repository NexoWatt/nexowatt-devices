/* global $, M, systemDictionary, translateAll */

let templatesData = null;
let templatesById = {};
let categories = [];
let manufacturersByCategory = {}; // cat -> [manu]
let templatesByCatManu = {}; // cat -> manu -> [template]
let devices = [];
let editIndex = -1;
let onChangeGlobal = null;

function safeJsonParse(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v;
  } catch (e) {
    return fallback;
  }
}

function setChanged(changed) {
  if (typeof onChangeGlobal === 'function') onChangeGlobal(changed);
}

function loadTemplates() {
  return new Promise((resolve, reject) => {
    if (templatesData) return resolve(templatesData);

    $.getJSON('templates.json')
      .done((data) => {
        templatesData = data;
        templatesById = {};
        manufacturersByCategory = {};
        templatesByCatManu = {};

        const tpls = (data && data.templates) ? data.templates : [];
        tpls.forEach((t) => {
          templatesById[t.id] = t;
          const cat = t.category || 'OTHER';
          const manu = t.manufacturer || 'Unknown';

          manufacturersByCategory[cat] = manufacturersByCategory[cat] || new Set();
          manufacturersByCategory[cat].add(manu);

          templatesByCatManu[cat] = templatesByCatManu[cat] || {};
          templatesByCatManu[cat][manu] = templatesByCatManu[cat][manu] || [];
          templatesByCatManu[cat][manu].push(t);
        });

        categories = Object.keys(manufacturersByCategory).sort();

        // Convert Sets to arrays
        Object.keys(manufacturersByCategory).forEach((cat) => {
          manufacturersByCategory[cat] = Array.from(manufacturersByCategory[cat]).sort();
        });

        resolve(templatesData);
      })
      .fail((xhr, status, err) => {
        console.error('Failed to load templates.json', status, err);
        reject(err);
      });
  });
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
    const tplName = tpl ? tpl.name : d.templateId;
    const connInfo = summarizeConnection(d);

    const row = $(`
      <tr>
        <td>${d.enabled ? '✓' : ''}</td>
        <td><code>${escapeHtml(d.id)}</code></td>
        <td>${escapeHtml(d.name || '')}</td>
        <td>${escapeHtml(d.category || '')}</td>
        <td>${escapeHtml(tplName || '')}</td>
        <td>${escapeHtml(d.protocol || '')}</td>
        <td>${escapeHtml(connInfo)}</td>
        <td>
          <a href="#!" class="btn-small waves-effect" data-action="edit" data-idx="${idx}"><i class="material-icons">edit</i></a>
          <a href="#!" class="btn-small red waves-effect" data-action="delete" data-idx="${idx}"><i class="material-icons">delete</i></a>
        </td>
      </tr>
    `);

    tbody.append(row);
  });
}

function escapeHtml(str) {
  return (str || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function summarizeConnection(d) {
  const c = d.connection || {};
  if (d.protocol === 'modbusTcp') {
    return `${c.host || ''}:${c.port || 502} (unit ${c.unitId ?? 1})`;
  }
  if (d.protocol === 'modbusRtu') {
    return `${c.path || ''} @${c.baudRate || 9600} (unit ${c.unitId ?? 1})`;
  }
  if (d.protocol === 'mqtt') {
    return `${c.url || ''}`;
  }
  if (d.protocol === 'http') {
    return `${c.baseUrl || ''}`;
  }
  return '';
}

function fillCategorySelect() {
  const sel = $('#dev_category');
  sel.empty();
  categories.forEach((cat) => {
    sel.append(`<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`);
  });
  sel.formSelect();
}

function fillManufacturerSelect(cat) {
  const sel = $('#dev_manufacturer');
  sel.empty();
  const manus = manufacturersByCategory[cat] || [];
  manus.forEach((m) => {
    sel.append(`<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`);
  });
  sel.formSelect();
}

function fillTemplateSelect(cat, manu) {
  const sel = $('#dev_template');
  sel.empty();
  const tpls = (templatesByCatManu[cat] && templatesByCatManu[cat][manu]) ? templatesByCatManu[cat][manu] : [];
  tpls.sort((a,b) => (a.name||a.id).localeCompare(b.name||b.id));
  tpls.forEach((t) => {
    sel.append(`<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`);
  });
  sel.formSelect();
}

function fillProtocolSelect(templateId, currentProtocol) {
  const sel = $('#dev_protocol');
  sel.empty();
  const tpl = templatesById[templateId];
  const protos = (tpl && tpl.protocols) ? tpl.protocols : [];
  protos.forEach((p) => {
    sel.append(`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`);
  });
  sel.formSelect();

  if (currentProtocol && protos.includes(currentProtocol)) {
    sel.val(currentProtocol);
    sel.formSelect();
  } else if (protos.length) {
    sel.val(protos[0]);
    sel.formSelect();
  }
}

function showConnBlock(protocol) {
  $('.connBlock').hide();
  if (protocol === 'modbusTcp') $('#conn_modbusTcp').show();
  if (protocol === 'modbusRtu') $('#conn_modbusRtu').show();
  if (protocol === 'mqtt') $('#conn_mqtt').show();
  if (protocol === 'http') $('#conn_http').show();
}

function renderDatapoints(templateId) {
  const tpl = templatesById[templateId];
  const tbody = $('#dpTable tbody');
  tbody.empty();

  if (!tpl || !tpl.datapoints) return;

  tpl.datapoints.forEach((dp) => {
    const src = dp.source || {};
    let srcKind = src.kind || '';
    let addr = '';
    let scale = '';
    if (srcKind === 'modbus') {
      addr = `FC${src.fc} @ ${src.address} (+${src.length} reg)`;
      scale = src.scaleFactor ?? 0;
    } else if (srcKind === 'mqtt') {
      addr = src.topic || '';
    } else if (srcKind === 'http') {
      addr = `${src.method || 'GET'} ${src.path || ''} -> ${src.jsonPath || ''}`;
    }
    const row = $(`
      <tr>
        <td><code>${escapeHtml(dp.id)}</code></td>
        <td>${escapeHtml(dp.rw || 'ro')}</td>
        <td>${escapeHtml(srcKind)}</td>
        <td>${escapeHtml(addr)}</td>
        <td>${escapeHtml(src.dataType || dp.type || '')}</td>
        <td>${escapeHtml(scale.toString())}</td>
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
  $('#dev_notes').val(device.notes || '');

  // category/manufacturer/template
  const cat = device.category || categories[0] || 'GENERIC';
  $('#dev_category').val(cat);
  $('#dev_category').formSelect();

  fillManufacturerSelect(cat);
  const manuList = manufacturersByCategory[cat] || [];
  const manu = device.manufacturer || (manuList[0] || '');
  $('#dev_manufacturer').val(manu);
  $('#dev_manufacturer').formSelect();

  fillTemplateSelect(cat, manu);
  const tplId = device.templateId || ($('#dev_template option:first').val() || '');
  $('#dev_template').val(tplId);
  $('#dev_template').formSelect();

  fillProtocolSelect(tplId, device.protocol);
  const proto = $('#dev_protocol').val();
  showConnBlock(proto);
  renderDatapoints(tplId);

  // connection defaults
  const c = device.connection || {};
  $('#mb_host').val(c.host || '');
  $('#mb_port').val(c.port ?? 502);
  $('#mb_unitId').val(c.unitId ?? 1);
  $('#mb_timeout').val(c.timeoutMs ?? '');
  $('#mb_addrOffset').val(c.addressOffset ?? '');

  $('#rtu_path').val(c.path || '');
  $('#rtu_baud').val(c.baudRate ?? 9600);
  $('#rtu_parity').val(c.parity || 'none');
  $('#rtu_unitId').val(c.unitId ?? 1);
  $('#rtu_timeout').val(c.timeoutMs ?? '');
  $('#rtu_addrOffset').val(c.addressOffset ?? '');
  $('#rtu_dataBits').val(c.dataBits ?? 8);
  $('#rtu_stopBits').val(c.stopBits ?? 1);
  $('#rtu_parity').formSelect();

  $('#mqtt_url').val(c.url || '');
  $('#mqtt_user').val(c.username || '');
  $('#mqtt_pass').val(c.password || '');

  $('#http_baseUrl').val(c.baseUrl || '');
  $('#http_user').val(c.username || '');
  $('#http_pass').val(c.password || '');

  M.updateTextFields();
  const modal = M.Modal.getInstance(document.getElementById('modalDevice'));
  modal.open();
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
    notes: ($('#dev_notes').val() || '').trim() || undefined,
    connection: {}
  };

  if (tpl && tpl.protocols && !tpl.protocols.includes(d.protocol)) {
    throw new Error('Protocol not supported by template');
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
  } else if (d.protocol === 'modbusRtu') {
    d.connection.path = ($('#rtu_path').val() || '').trim();
    d.connection.baudRate = parseInt($('#rtu_baud').val(), 10) || 9600;
    d.connection.parity = $('#rtu_parity').val() || 'none';
    d.connection.unitId = parseInt($('#rtu_unitId').val(), 10) || 1;
    const t = parseInt($('#rtu_timeout').val(), 10);
    if (!isNaN(t)) d.connection.timeoutMs = t;
    const o = parseInt($('#rtu_addrOffset').val(), 10);
    if (!isNaN(o)) d.connection.addressOffset = o;
    d.connection.dataBits = parseInt($('#rtu_dataBits').val(), 10) || 8;
    d.connection.stopBits = parseInt($('#rtu_stopBits').val(), 10) || 1;
  } else if (d.protocol === 'mqtt') {
    d.connection.url = ($('#mqtt_url').val() || '').trim();
    d.connection.username = ($('#mqtt_user').val() || '').trim() || undefined;
    d.connection.password = ($('#mqtt_pass').val() || '').trim() || undefined;
  } else if (d.protocol === 'http') {
    d.connection.baseUrl = ($('#http_baseUrl').val() || '').trim();
    d.connection.username = ($('#http_user').val() || '').trim() || undefined;
    d.connection.password = ($('#http_pass').val() || '').trim() || undefined;
  }

  // minimal validation
  if (!d.id) throw new Error('Missing device id');
  if (!/^[a-zA-Z0-9_\-]+$/.test(d.id)) throw new Error('Invalid device id. Use letters, numbers, underscore, dash.');
  if (!d.templateId) throw new Error('Missing template');
  if (!d.protocol) throw new Error('Missing protocol');

  if (d.protocol === 'modbusTcp' && !d.connection.host) throw new Error('Missing Modbus TCP host');
  if (d.protocol === 'modbusRtu' && !d.connection.path) throw new Error('Missing Modbus RTU serial port');
  if (d.protocol === 'mqtt' && !d.connection.url) throw new Error('Missing MQTT broker URL');
  if (d.protocol === 'http' && !d.connection.baseUrl) throw new Error('Missing HTTP base URL');

  return d;
}

function updateJsonPreview() {
  const jsonStr = JSON.stringify(devices, null, 2);
  $('#devicesJson').val(jsonStr);
  $('#jsonPreview').text(jsonStr);
}

function initEventHandlers() {
  $('#btnShowJson').on('click', () => {
    const shown = $('#jsonPreview').is(':visible');
    if (shown) {
      $('#jsonPreview').hide();
    } else {
      updateJsonPreview();
      $('#jsonPreview').show();
    }
  });

  $('#btnAddDevice').on('click', () => {
    openDeviceModal({ enabled: true }, -1);
  });

  // table actions
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

  // modal dependent selects
  $('#dev_category').on('change', () => {
    const cat = $('#dev_category').val();
    fillManufacturerSelect(cat);
    const manu = $('#dev_manufacturer').val();
    fillTemplateSelect(cat, manu);
    const tplId = $('#dev_template').val();
    fillProtocolSelect(tplId);
    showConnBlock($('#dev_protocol').val());
    renderDatapoints(tplId);
    M.updateTextFields();
  });

  $('#dev_manufacturer').on('change', () => {
    const cat = $('#dev_category').val();
    const manu = $('#dev_manufacturer').val();
    fillTemplateSelect(cat, manu);
    const tplId = $('#dev_template').val();
    fillProtocolSelect(tplId);
    showConnBlock($('#dev_protocol').val());
    renderDatapoints(tplId);
    M.updateTextFields();
  });

  $('#dev_template').on('change', () => {
    const tplId = $('#dev_template').val();
    fillProtocolSelect(tplId);
    showConnBlock($('#dev_protocol').val());
    renderDatapoints(tplId);
    M.updateTextFields();
  });

  $('#dev_protocol').on('change', () => {
    showConnBlock($('#dev_protocol').val());
  });

  $('#btnSaveDevice').on('click', () => {
    try {
      const d = collectDeviceFromModal();

      // uniqueness check
      const existsIdx = devices.findIndex((x, i) => x.id === d.id && i !== editIndex);
      if (existsIdx >= 0) {
        throw new Error('Device id already exists');
      }

      if (editIndex >= 0) {
        devices[editIndex] = d;
      } else {
        devices.push(d);
      }

      devices.sort((a,b) => (a.id||'').localeCompare(b.id||''));

      renderDevicesTable();
      updateJsonPreview();
      setChanged(true);

      const modal = M.Modal.getInstance(document.getElementById('modalDevice'));
      modal.close();
    } catch (e) {
      M.toast({ html: 'Fehler: ' + escapeHtml(e.message || e.toString()) });
    }
  });
}

function initUIOnce() {
  // modal init
  const elems = document.querySelectorAll('.modal');
  M.Modal.init(elems, { dismissible: false });

  // init selects
  $('select').formSelect();

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
  M.updateTextFields();
}

// ioBroker admin hooks
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
      initUIOnce();
      applySettingsToUI(settings);
      console.error(e);
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