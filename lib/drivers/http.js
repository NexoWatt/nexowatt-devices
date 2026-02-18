'use strict';

const axios = require('axios');
const { getByJsonPath, applyNumericTransforms } = require('../utils');

function renderTemplate(str, value, encode) {
  if (typeof str !== 'string') return str;
  const v = String(value);
  const rep = encode ? encodeURIComponent(v) : v;
  return str.replace(/\{value\}/g, rep);
}

function applyValueMap(value, valueMap) {
  if (!valueMap || typeof valueMap !== 'object') return value;
  const key = String(value);
  if (Object.prototype.hasOwnProperty.call(valueMap, key)) return valueMap[key];
  return value;
}

function coerceBoolean(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'true' || s === 'on' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'off' || s === 'no' || s === '0') return false;
  }
  return val;
}

class HttpDriver {
  constructor(adapter, deviceConfig, template, globalConfig) {
    this.adapter = adapter;
    this.device = deviceConfig;
    this.template = template;
    this.global = globalConfig || {};

    const c = deviceConfig.connection || {};
    this.baseUrl = (c.baseUrl || '').replace(/\/$/, '');
    this.username = c.username;
    this.password = c.password;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      auth: (this.username && this.password) ? { username: this.username, password: this.password } : undefined,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  }

  async connect() {
    // stateless
  }

  async disconnect() {
    // stateless
  }

  async readDatapoints(datapoints) {
    const out = {};
    const httpDps = (datapoints || []).filter(dp => dp.source && dp.source.kind === 'http');
    for (const dp of httpDps) {
      const src = dp.source || {};
      const method = (src.method || 'GET').toUpperCase();
      const url = src.path || '/';
      try {
        const res = await this.http.request({ method, url });
        const data = res.data;

        let val = data;
        if (src.jsonPath) val = getByJsonPath(data, src.jsonPath);

        // Numeric transforms (scaleFactor, multiplier, divisor, offset, invert, ...)
        val = applyNumericTransforms(val, src);

        // Optional boolean coercion
        if ((dp.type || '').toString().toLowerCase() === 'boolean') {
          val = coerceBoolean(val);
        }

        if (val === undefined) continue;

        // If a datapoint expects a string but JSONPath returned an object/array, store it as JSON string.
        if ((dp.type || '').toString().toLowerCase() === 'string' && val && typeof val === 'object') {
          try { val = JSON.stringify(val); } catch (e) { /* ignore */ }
        }

        out[dp.id] = val;
      } catch (e) {
        this.adapter.log.warn(`[${this.device.id}] HTTP read failed for ${method} ${url}: ${e.message || e}`);
      }
    }
    return out;
  }

  async writeDatapoint(dp, value) {
    const src = dp.source || {};
    const method = (src.writeMethod || src.method || 'POST').toUpperCase();

    // Optional value mapping (e.g. boolean -> on/off)
    const mappedValue = applyValueMap(value, src.valueMap);

    // URL templating: allow "{value}" placeholder (URL-encoded)
    const urlTemplate = src.writePath || src.path || '/';
    const url = renderTemplate(urlTemplate, mappedValue, true);

    // Build body (for non-GET methods)
    let body = undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      if (src.bodyTemplate) {
        body = renderTemplate(src.bodyTemplate, mappedValue, false);
        if ((src.bodyType || '').toLowerCase() === 'json') {
          body = JSON.parse(body);
        }
      } else if (src.bodyType && src.bodyType.toLowerCase() === 'json') {
        body = { value: mappedValue };
      } else if (src.bodyType && src.bodyType.toLowerCase() === 'text') {
        body = String(mappedValue);
      } else {
        body = mappedValue;
      }
    }

    await this.http.request({ method, url, data: body });
  }
}

module.exports = {
  HttpDriver,
};
