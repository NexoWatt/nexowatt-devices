'use strict';

const mqtt = require('mqtt');
const { roundTo, normalizeValueByUnit } = require('../utils');

class MqttDriver {
  constructor(adapter, deviceConfig, template, globalConfig, stateIdForDp, getDecimalsForDp) {
    this.adapter = adapter;
    this.device = deviceConfig;
    this.template = template;
    this.global = globalConfig || {};
    this.stateIdForDp = stateIdForDp;
    this.getDecimalsForDp = (typeof getDecimalsForDp === 'function') ? getDecimalsForDp : null;

    this.client = null;
    this.connected = false;

    this.topicToDp = new Map();
  }

  async connect(datapoints) {
    if (this.connected) return;

    const c = this.device.connection || {};
    const url = c.url;
    const options = {};
    if (c.username) options.username = c.username;
    if (c.password) options.password = c.password;

    // modest reconnect behavior
    options.reconnectPeriod = 5000;
    options.connectTimeout = 10000;

    this.client = mqtt.connect(url, options);

    this.client.on('connect', () => {
      this.connected = true;
      this.adapter.log.info(`[${this.device.id}] MQTT connected`);
    });

    this.client.on('reconnect', () => {
      this.adapter.log.warn(`[${this.device.id}] MQTT reconnecting...`);
    });

    this.client.on('close', () => {
      this.connected = false;
    });

    this.client.on('error', (err) => {
      this.adapter.log.warn(`[${this.device.id}] MQTT error: ${err && err.message ? err.message : err}`);
    });

    // topics
    const mqttDps = (datapoints || []).filter(dp => dp.source && dp.source.kind === 'mqtt' && dp.source.topic);
    const topics = new Set();
    mqttDps.forEach(dp => {
      const topic = dp.source.topic;
      this.topicToDp.set(topic, dp);
      topics.add(topic);
    });

    this.client.on('message', async (topic, payload) => {
      const dp = this.topicToDp.get(topic);
      if (!dp) return;
      const stateId = this.stateIdForDp(dp);
      if (!stateId) return;

      try {
        let parsed = this._parsePayload(dp, payload);

        // Unit-specific normalization (same policy as polling)
        parsed = normalizeValueByUnit(parsed, dp);

        // Apply the same rounding policy as Modbus polling (keeps state values consistent across protocols)
        if (typeof parsed === 'number' && Number.isFinite(parsed) && this.getDecimalsForDp) {
          const dec = this.getDecimalsForDp(dp);
          if (typeof dec === 'number' && Number.isFinite(dec) && dec >= 0 && dec <= 10) {
            parsed = roundTo(parsed, dec);
          }
        }

        await this.adapter.setStateAsync(stateId, { val: parsed, ack: true });
      } catch (e) {
        this.adapter.log.warn(`[${this.device.id}] MQTT parse error for topic ${topic}: ${e.message || e}`);
      }
    });

    if (topics.size) {
      this.client.subscribe(Array.from(topics), { qos: 0 }, (err) => {
        if (err) this.adapter.log.warn(`[${this.device.id}] MQTT subscribe error: ${err.message || err}`);
      });
    }
  }

  async disconnect() {
    try {
      if (this.client) {
        await new Promise(resolve => this.client.end(false, {}, resolve));
      }
    } catch (e) {
      // ignore
    } finally {
      this.connected = false;
      this.client = null;
    }
  }

  _parsePayload(dp, payload) {
    const src = dp.source || {};
    const fmt = (src.format || dp.type || 'string').toString().toLowerCase();
    const s = payload.toString('utf8');

    if (fmt === 'number' || fmt === 'float' || fmt === 'int') {
      const n = Number(s);
      if (isNaN(n)) throw new Error(`Not a number: ${s}`);
      return n;
    }
    if (fmt === 'boolean' || fmt === 'bool') {
      if (s === '1' || s.toLowerCase() === 'true' || s.toLowerCase() === 'on') return true;
      if (s === '0' || s.toLowerCase() === 'false' || s.toLowerCase() === 'off') return false;
      // fallback: truthy
      return !!s;
    }
    if (fmt === 'json') {
      return JSON.parse(s);
    }
    return s;
  }

  _formatPayload(dp, value) {
    const src = dp.source || {};
    const fmt = (src.format || dp.type || 'string').toString().toLowerCase();

    if (fmt === 'json') return JSON.stringify(value);
    if (fmt === 'boolean' || fmt === 'bool') return (value ? '1' : '0');
    if (fmt === 'number' || fmt === 'float' || fmt === 'int') return String(Number(value));
    return String(value);
  }

  async readDatapoints(/* datapoints */) {
    // MQTT is event-driven; nothing to poll here.
    return {};
  }

  async writeDatapoint(dp, value) {
    const src = dp.source || {};
    if (!this.client) throw new Error('MQTT not connected');
    const topic = src.topic;
    if (!topic) throw new Error('Missing topic');

    const payload = this._formatPayload(dp, value);
    await new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 0, retain: false }, (err) => err ? reject(err) : resolve());
    });
  }
}

module.exports = {
  MqttDriver,
};