'use strict';

const fs = require('fs');
const path = require('path');
const utils = require('@iobroker/adapter-core');

const { DeviceRuntime } = require('./lib/deviceRuntime');

function readTemplates(adapter) {
  try {
    const p = path.join(__dirname, 'lib', 'templates.json');
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const templates = Array.isArray(data.templates) ? data.templates : [];
    const byId = {};
    for (const t of templates) byId[t.id] = t;
    return { templates, byId };
  } catch (e) {
    adapter.log.error(`Failed to load templates.json: ${e.message || e}`);
    return { templates: [], byId: {} };
  }
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}


async function autoFixAdminUI(adapter) {
  // Some environments contain legacy adapter objects with common.adminUI stored as a STRING (e.g. "materialize").
  // Newer Admin versions expect common.adminUI to be an OBJECT. If it is a string, Admin can throw:
  // "Cannot create property 'config' on string 'materialize'".
  //
  // This migration is safe: it only converts string -> { config: <string> } and does not change any other fields.
  const patterns = ['system.host.*.adapter.*', 'system.adapter.*'];

  for (const pattern of patterns) {
    let objs;
    try {
      objs = await adapter.getForeignObjectsAsync(pattern);
    } catch (e) {
      adapter.log.debug(`adminUI auto-fix: cannot read ${pattern}: ${e && e.message ? e.message : e}`);
      continue;
    }

    const map = objs || {};
    for (const [id, obj] of Object.entries(map)) {
      if (!obj || obj.type !== 'adapter' || !obj.common) continue;
      const adminUI = obj.common.adminUI;
      if (typeof adminUI === 'string' && adminUI.trim()) {
        const cfg = adminUI.trim();
        try {
          await adapter.extendForeignObjectAsync(id, { common: { adminUI: { config: cfg } } });
          adapter.log.info(`adminUI migrated for ${id}: "${cfg}" -> {config:"${cfg}"}`);
        } catch (e) {
          adapter.log.debug(`adminUI auto-fix failed for ${id}: ${e && e.message ? e.message : e}`);
        }
      }
    }
  }
}

async function autoMigrateLegacyDevicesJson(adapter) {
  // Migrate legacy config field `devicesJson` (stringified array) into `native.devices` (array)
  // so modern JSON-config admin UI can show existing devices.
  try {
    const hasDevicesArray = Array.isArray(adapter.config.devices) && adapter.config.devices.length > 0;
    if (hasDevicesArray) return;

    const jsonStr = adapter.config.devicesJson;
    if (!jsonStr || typeof jsonStr !== 'string') return;
    const parsed = safeJsonParse(jsonStr, null);
    if (!Array.isArray(parsed) || !parsed.length) return;

    const id = `system.adapter.${adapter.name}.${adapter.instance}`;
    const obj = await adapter.getForeignObjectAsync(id);
    if (!obj || !obj.native) return;

    if (Array.isArray(obj.native.devices) && obj.native.devices.length > 0) return;

    await adapter.extendForeignObjectAsync(id, { native: { devices: parsed } });
    adapter.log.info(`Migrated legacy devicesJson -> devices array (${parsed.length} devices). Please re-open the instance config.`);
  } catch (e) {
    adapter.log.debug(`devicesJson auto-migration failed: ${e && e.message ? e.message : e}`);
  }
}


class NexowattDevicesAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'nexowatt-devices',
    });

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.on('message', this.onMessage.bind(this));

    this.templateRegistry = { templates: [], byId: {} };
    this.deviceRuntimes = [];
    this.deviceById = new Map();
  }

  async onReady() {
    // Automatic environment migration (no manual user steps)
    await autoFixAdminUI(this);
    await autoMigrateLegacyDevicesJson(this);

    // init info
    await this.setObjectNotExistsAsync('info.connection', {
      type: 'state',
      common: {
        name: 'Connected',
        type: 'boolean',
        role: 'indicator.connected',
        read: true,
        write: false,
        def: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync('devices', {
      type: 'channel',
      common: { name: 'Devices' },
      native: {}
    });

    this.templateRegistry = readTemplates(this);

    // parse devices config (preferred: native.devices array, fallback: legacy devicesJson)
    const devicesCfg = Array.isArray(this.config.devices) ? this.config.devices : safeJsonParse(this.config.devicesJson || '[]', []);
    const devices = Array.isArray(devicesCfg) ? devicesCfg : [];

    const globalConfig = {
      pollIntervalMs: Number(this.config.pollIntervalMs || 5000),
      modbusTimeoutMs: Number(this.config.modbusTimeoutMs || 2000),
      registerAddressOffset: Number(this.config.registerAddressOffset || 0),
    };

    if (!devices.length) {
      this.log.warn('No devices configured. Add devices in the admin UI.');
      await this.setStateAsync('info.connection', { val: false, ack: true });
      return;
    }

    // create runtimes
    for (const d of devices) {
      try {
        if (!d || !d.id) continue;
        const tpl = this.templateRegistry.byId[d.templateId];
        if (!tpl) {
          this.log.warn(`[${d.id}] Template not found: ${d.templateId}`);
          continue;
        }

        // ensure some defaults
        if (!d.category) d.category = tpl.category;
        if (!d.manufacturer) d.manufacturer = tpl.manufacturer;

        const rt = new DeviceRuntime(this, d, tpl, globalConfig);
        await rt.initObjects();
        await rt.start();

        this.deviceRuntimes.push(rt);
        this.deviceById.set(d.id, rt);
      } catch (e) {
        this.log.warn(`Failed to start device: ${e.message || e}`);
      }
    }

    // subscribe to all device states (writes)
    this.subscribeStates('devices.*');

    // overall connection: true if at least one enabled device exists
    const anyEnabled = devices.some(d => d && d.enabled !== false);
    await this.setStateAsync('info.connection', { val: anyEnabled, ack: true });
  }

  async onStateChange(id, state) {
    if (!id || !state) return;

    // dispatch to runtime by prefix match
    for (const rt of this.deviceRuntimes) {
      const prefix = this.namespace + '.' + rt.baseId + '.';
      if (id.startsWith(prefix) || id === this.namespace + '.' + rt.baseId) {
        await rt.handleStateChange(id, state);
        return;
      }
    }
  }

  _ensureTemplatesLoaded() {
    try {
      if (this.templateRegistry && Array.isArray(this.templateRegistry.templates) && this.templateRegistry.templates.length) return;
      this.templateRegistry = readTemplates(this);
    } catch (e) {
      // ignore
    }
  }

  _categoryLabel(cat) {
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

  _protocolLabel(p) {
    const s = (p || '').toString();
    switch (s) {
      case 'modbusTcp': return 'Modbus TCP';
      case 'modbusRtu': return 'Modbus RTU';
      case 'modbusAscii': return 'Modbus ASCII';
      case 'mqtt': return 'MQTT';
      case 'http': return 'HTTP/JSON';
      case 'udp': return 'UDP';
      case 'speedwire': return 'Speedwire';
      case 'mbus': return 'M-Bus';
      case 'onewire': return '1-Wire';
      case 'canbus': return 'CANbus';
      default: return s;
    }
  }

  async onMessage(obj) {
    if (!obj || !obj.command) return;
    if (!obj.callback) return;

    try {
      this._ensureTemplatesLoaded();

      const templates = (this.templateRegistry && Array.isArray(this.templateRegistry.templates)) ? this.templateRegistry.templates : [];
      const byId = (this.templateRegistry && this.templateRegistry.byId) ? this.templateRegistry.byId : {};

      const cmd = obj.command;
      const msg = obj.message || {};

      if (cmd === 'getCategories') {
        const set = new Set();
        for (const t of templates) {
          if (t && t.category) set.add(String(t.category));
        }
        const arr = Array.from(set);
        arr.sort((a, b) => a.localeCompare(b));
        const res = arr.map(c => ({ value: c, label: this._categoryLabel(c) }));
        return this.sendTo(obj.from, obj.command, res, obj.callback);
      }

      if (cmd === 'getManufacturers') {
        const category = (msg.category || '').toString();
        const set = new Set();
        for (const t of templates) {
          if (!t) continue;
          if (category && String(t.category) !== category) continue;
          if (t.manufacturer) set.add(String(t.manufacturer));
        }
        const arr = Array.from(set);
        arr.sort((a, b) => a.localeCompare(b));
        const res = arr.map(m => ({ value: m, label: m }));
        return this.sendTo(obj.from, obj.command, res, obj.callback);
      }

      if (cmd === 'getTemplates') {
        const category = (msg.category || '').toString();
        const manufacturer = (msg.manufacturer || '').toString();

        // Avoid returning huge lists; require category+manufacturer.
        if (!category || !manufacturer) {
          return this.sendTo(obj.from, obj.command, [], obj.callback);
        }

        const res = [];
        for (const t of templates) {
          if (!t) continue;
          if (String(t.category) !== category) continue;
          if (String(t.manufacturer) !== manufacturer) continue;

          const parts = [t.manufacturer, t.model, t.name].filter(Boolean);
          const label = (parts.join(' ').trim()) || t.id;
          const protos = Array.isArray(t.protocols) ? t.protocols.join(', ') : '';
          res.push({
            value: t.id,
            label,
            description: protos ? `${t.id} (${protos})` : t.id,
          });
        }

        res.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
        return this.sendTo(obj.from, obj.command, res, obj.callback);
      }

      if (cmd === 'getProtocols') {
        const templateId = (msg.templateId || '').toString();
        const tpl = templateId ? byId[templateId] : null;
        const protos = (tpl && Array.isArray(tpl.protocols) && tpl.protocols.length) ? tpl.protocols : [
          'modbusTcp', 'modbusRtu', 'modbusAscii', 'mqtt', 'http', 'udp', 'speedwire', 'mbus', 'onewire', 'canbus'
        ];
        const res = Array.from(new Set(protos.map(p => String(p)))).map(p => ({ value: p, label: this._protocolLabel(p) }));
        return this.sendTo(obj.from, obj.command, res, obj.callback);
      }

      // Unknown command
      return this.sendTo(obj.from, obj.command, [], obj.callback);
    } catch (e) {
      // reply with empty list on error to keep admin UI usable
      try {
        this.sendTo(obj.from, obj.command, [], obj.callback);
      } catch (_) {
        // ignore
      }
      this.log.debug(`onMessage(${obj.command}) failed: ${e && e.message ? e.message : e}`);
    }
  }


  async onUnload(callback) {
    try {
      for (const rt of this.deviceRuntimes) {
        try { await rt.stop(); } catch (e) { /* ignore */ }
      }
      this.deviceRuntimes = [];
      await this.setStateAsync('info.connection', { val: false, ack: true }).catch(() => {});
      callback();
    } catch (e) {
      callback();
    }
  }
}

if (module.parent) {
  module.exports = (options) => new NexowattDevicesAdapter(options);
} else {
  new NexowattDevicesAdapter();
}