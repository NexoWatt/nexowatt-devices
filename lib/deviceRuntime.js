'use strict';

const path = require('path');
const { ModbusDriver } = require('./drivers/modbus');
const { MqttDriver } = require('./drivers/mqtt');
const { HttpDriver } = require('./drivers/http');

class DeviceRuntime {
  constructor(adapter, deviceConfig, template, globalConfig) {
    this.adapter = adapter;
    this.cfg = deviceConfig;
    this.template = template;
    this.global = globalConfig || {};

    this.baseId = `devices.${this.cfg.id}`;
    this.dpByStateRelId = new Map(); // relId -> dpDef
    this.dpById = new Map(); // dpId -> dpDef

    this.driver = null;
    this.pollTimer = null;
    this.started = false;
  }

  getDatapoints() {
    return (this.template && Array.isArray(this.template.datapoints)) ? this.template.datapoints : [];
  }

  relStateId(dp) {
    return `${this.baseId}.${dp.id}`;
  }

  async initObjects() {
    await this.adapter.setObjectNotExistsAsync(this.baseId, {
      type: 'channel',
      common: { name: this.cfg.name || this.cfg.id },
      native: {
        deviceId: this.cfg.id,
        templateId: this.cfg.templateId,
        category: this.cfg.category,
        manufacturer: this.cfg.manufacturer,
      }
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info`, {
      type: 'channel',
      common: { name: 'Info' },
      native: {}
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info.connection`, {
      type: 'state',
      common: {
        name: 'Connection',
        type: 'boolean',
        role: 'indicator.connected',
        read: true,
        write: false,
        def: false
      },
      native: {}
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info.lastError`, {
      type: 'state',
      common: {
        name: 'Last error',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: ''
      },
      native: {}
    });

    const dps = this.getDatapoints();
    for (const dp of dps) {
      const relId = this.relStateId(dp);

      const src = dp.source || {};
      const common = {
        name: dp.name || dp.id,
        type: dp.type || 'number',
        role: dp.role || 'value',
        read: dp.rw !== 'wo',
        write: dp.rw === 'rw' || dp.rw === 'wo',
      };

      if (src.kind === 'modbus') {
        common.unit = dp.unit || '';
      }

      await this.adapter.setObjectNotExistsAsync(relId, {
        type: 'state',
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          datapointId: dp.id,
          source: src,
        }
      });

      this.dpByStateRelId.set(relId, dp);
      this.dpById.set(dp.id, dp);
    }
  }

  _createDriver() {
    const proto = this.cfg.protocol;
    if (proto === 'modbusTcp' || proto === 'modbusRtu') {
      return new ModbusDriver(this.adapter, this.cfg, this.template, this.global);
    }
    if (proto === 'mqtt') {
      // MQTT driver needs mapping dp -> state id
      return new MqttDriver(this.adapter, this.cfg, this.template, this.global, (dp) => this.relStateId(dp));
    }
    if (proto === 'http') {
      return new HttpDriver(this.adapter, this.cfg, this.template, this.global);
    }
    throw new Error(`Unsupported protocol: ${proto}`);
  }

  async start() {
    if (this.started) return;
    this.started = true;

    if (this.cfg.enabled === false) {
      this.adapter.log.info(`[${this.cfg.id}] disabled - skipping`);
      return;
    }

    this.driver = this._createDriver();

    // MQTT subscribes on connect
    if (this.cfg.protocol === 'mqtt') {
      try {
        await this.driver.connect(this.getDatapoints());
      } catch (e) {
        await this._setError(e);
      }
      // no polling required, but keep connection state
      await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: true, ack: true }).catch(() => {});
      return;
    }

    // polling
    const pollMs = Number(this.cfg.pollIntervalMs || this.global.pollIntervalMs || 5000);
    const doPoll = async () => {
      if (!this.driver) return;
      try {
        const values = await this.driver.readDatapoints(this.getDatapoints());
        await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: true, ack: true }).catch(() => {});
        await this.adapter.setStateAsync(`${this.baseId}.info.lastError`, { val: '', ack: true }).catch(() => {});
        for (const [dpId, val] of Object.entries(values)) {
          const dp = this.dpById.get(dpId);
          if (!dp) continue;
          const relId = this.relStateId(dp);
          await this.adapter.setStateAsync(relId, { val, ack: true });
        }
      } catch (e) {
        await this._setError(e);
      }
    };

    // run once quickly
    await doPoll();

    this.pollTimer = setInterval(doPoll, Math.max(250, pollMs));
  }

  async _setError(e) {
    const msg = (e && e.message) ? e.message : String(e);
    this.adapter.log.warn(`[${this.cfg.id}] ${msg}`);
    await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: false, ack: true }).catch(() => {});
    await this.adapter.setStateAsync(`${this.baseId}.info.lastError`, { val: msg, ack: true }).catch(() => {});
  }

  async stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.driver) {
      try { await this.driver.disconnect(); } catch (e) { /* ignore */ }
      this.driver = null;
    }
    this.started = false;
  }

  async handleStateChange(fullId, state) {
    if (!state || state.ack) return;
    // Convert full id -> relative id
    const relPrefix = this.adapter.namespace + '.';
    const relId = fullId.startsWith(relPrefix) ? fullId.substring(relPrefix.length) : fullId;

    const dp = this.dpByStateRelId.get(relId);
    if (!dp) return;
    if (!(dp.rw === 'rw' || dp.rw === 'wo')) return;
    if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;

    try {
      await this.driver.writeDatapoint(dp, state.val);
      // ack the written value
      await this.adapter.setStateAsync(relId, { val: state.val, ack: true });
    } catch (e) {
      await this._setError(e);
    }
  }
}

module.exports = {
  DeviceRuntime,
};