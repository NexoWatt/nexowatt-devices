'use strict';

const axios = require('axios');

function getByPath(obj, path) {
  if (!path) return obj;
  const parts = path.split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
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
        if (src.jsonPath) val = getByPath(data, src.jsonPath);
        if (dp.type === 'number' && typeof val === 'string') {
          const n = Number(val);
          if (!isNaN(n)) val = n;
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
    const url = src.writePath || src.path || '/';
    let body = undefined;

    if (src.bodyTemplate) {
      body = src.bodyTemplate.replace(/\{value\}/g, String(value));
      // try json
      if ((src.bodyType || '').toLowerCase() === 'json') {
        body = JSON.parse(body);
      }
    } else if (src.bodyType && src.bodyType.toLowerCase() === 'json') {
      body = { value };
    } else {
      body = value;
    }

    await this.http.request({ method, url, data: body });
  }
}

module.exports = {
  HttpDriver,
};