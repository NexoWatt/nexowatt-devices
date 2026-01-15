'use strict';

/**
 * SMA Speedwire (UDP multicast/unicast) driver.
 *
 * Primary supported payload:
 *   - SMA Energy Meter / Sunny Home Manager meter telegrams (protocol-id 0x6069)
 *
 * This driver is designed as a *listener* (multicast/unicast). It does not poll
 * by sending requests. Instead, it keeps the most recent telegram in memory and
 * serves datapoint reads from that cache.
 */

const dgram = require('node:dgram');

function _errMsg(err) {
  try { return (err && err.message) ? String(err.message) : String(err); } catch (_) { return ''; }
}

function isMulticastIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  return Number.isFinite(a) && a >= 224 && a <= 239;
}

function toHex(n, len = 4) {
  try {
    const s = (Number(n) >>> 0).toString(16).toUpperCase();
    return '0x' + s.padStart(len, '0');
  } catch (_) {
    return String(n);
  }
}

function findProtocolIdOffset(buf) {
  // We support:
  //   - 0x6069 (meter multicast/unicast)
  //   - 0x6081 (SHM 2.0 unicast firmware 2.07.x) – best-effort
  //
  // The protocol-id is encoded as big-endian uint16.
  // We search for these byte patterns.
  if (!Buffer.isBuffer(buf) || buf.length < 24) return -1;

  const candidates = [
    Buffer.from([0x60, 0x69]),
    Buffer.from([0x60, 0x81]),
  ];

  // The protocol-id is part of the Speedwire header (near the beginning).
  // To avoid false-positives in payload values, we limit the search window.
  const head = buf.subarray(0, Math.min(buf.length, 64));
  for (const needle of candidates) {
    const idx = head.indexOf(needle, 0);
    if (idx >= 0) return idx;
  }
  return -1;
}

function normalizeObisValue(c, d, raw) {
  // `raw` is int32 (for d==4) or BigInt (for d==8).

  if (raw === null || raw === undefined) return undefined;

  // Energy meter reading (IEC OBIS measurement type 8): SMA uses Ws.
  if (d === 8) {
    // Convert Ws -> kWh
    try {
      const ws = (typeof raw === 'bigint') ? raw : BigInt(raw);
      const kwh = Number(ws) / 3600000;
      if (!Number.isFinite(kwh)) return undefined;
      return kwh;
    } catch (_) {
      return undefined;
    }
  }

  // Current average values (measurement type 4)
  if (d === 4) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;

    // Currents (mA -> A)
    if (c === 31 || c === 51 || c === 71) return n / 1000;

    // Voltages (mV -> V)
    if (c === 32 || c === 52 || c === 72) return n / 1000;

    // Power factor (0.001)
    if (c === 13 || c === 33 || c === 53 || c === 73) return n / 1000;

    // Frequency (best-effort): common implementations use 0.01 Hz steps
    if (c === 14) return n / 100;

    // Default: power values (SMA spec states 0.1 W resolution)
    // Convert to kW: 0.1 W -> kW => / 10 / 1000 => / 10000
    return n / 10000;
  }

  // Unknown measurement types (manufacturer specific). Provide raw numeric best-effort.
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseEnergyMeterTelegram(buf) {
  // Minimal parser for SMA Speedwire energy meter telegrams.
  // Returns { protocolId, susyId, serialNumber, timestampMs, valuesByCde }.

  if (!Buffer.isBuffer(buf) || buf.length < 40) return null;

  // Optional header sanity: starts with "SMA"\0
  const header = buf.subarray(0, 4).toString('ascii');
  if (!header.startsWith('SMA')) {
    // Not an SMA telegram – ignore silently.
    return null;
  }

  const protoOffset = findProtocolIdOffset(buf);
  if (protoOffset < 0 || protoOffset + 2 >= buf.length) return null;

  const protocolId = buf.readUInt16BE(protoOffset);
  const payloadStart = protoOffset + 2;

  // Payload begins with 6 bytes SMA device address:
  //   susyId (uint16 BE) + serialNumber (uint32 BE)
  if (payloadStart + 10 > buf.length) return null;

  const susyId = buf.readUInt16BE(payloadStart);
  const serialNumber = buf.readUInt32BE(payloadStart + 2);
  const timestampMs = buf.readUInt32BE(payloadStart + 6);

  // OBIS data fields begin after address (6) + timestamp (4)
  let p = payloadStart + 10;
  const valuesByCde = new Map(); // key: `${c}.${d}.${e}`
  const valuesByBcde = new Map(); // key: `${b}:${c}.${d}.${e}`

  // The telegram is fixed-length (600/608 bytes), but it contains an end-marker OBIS.
  while (p + 8 <= buf.length) {
    const b = buf.readUInt8(p);
    const c = buf.readUInt8(p + 1);
    const d = buf.readUInt8(p + 2);
    const e = buf.readUInt8(p + 3);
    p += 4;

    // End of data
    if (b === 0 && c === 0 && d === 0 && e === 0) break;

    let raw;
    if (d === 8) {
      if (p + 8 > buf.length) break;
      try {
        raw = buf.readBigUInt64BE(p);
      } catch (_) {
        // Fallback for environments without BigInt read helper
        const hi = buf.readUInt32BE(p);
        const lo = buf.readUInt32BE(p + 4);
        raw = (BigInt(hi) << 32n) + BigInt(lo);
      }
      p += 8;
    } else {
      if (p + 4 > buf.length) break;
      raw = buf.readInt32BE(p);
      p += 4;
    }

    const val = normalizeObisValue(c, d, raw);
    const keyCde = `${c}.${d}.${e}`;
    const keyBcde = `${b}:${keyCde}`;
    valuesByBcde.set(keyBcde, val);

    // Convenience: keep first-seen value per C/D/E (covers channel 0 vs 1 differences)
    if (!valuesByCde.has(keyCde)) valuesByCde.set(keyCde, val);
  }

  return {
    protocolId,
    susyId,
    serialNumber,
    timestampMs,
    valuesByCde,
    valuesByBcde,
  };
}


class SpeedwireHub {
  constructor(adapter, opts) {
    this.adapter = adapter;
    this.port = Number(opts.port || 9522);
    this.multicastGroup = (opts.multicastGroup || '239.12.255.254').toString();
    this.interfaceAddress = (opts.interfaceAddress || '').toString().trim();

    this.socket = null;
    this.started = false;
    this.starting = null;
    this.handlers = new Set();
  }

  _logDebug(msg) {
    try {
      if (this.adapter?.log?.debug) this.adapter.log.debug(msg);
    } catch (_) { /* ignore */ }
  }

  _logWarn(msg) {
    try {
      if (this.adapter?.log?.warn) this.adapter.log.warn(msg);
    } catch (_) { /* ignore */ }
  }

  async start() {
    if (this.started) return;
    if (this.starting) return await this.starting;

    this.starting = (async () => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = sock;

      sock.on('error', (err) => {
        this._logWarn(`[speedwire] UDP socket error (${this.multicastGroup}:${this.port}): ${_errMsg(err)}`);
        try { sock.close(); } catch (_) { /* ignore */ }
        this.socket = null;
        this.started = false;
        this.starting = null;
      });

      sock.on('message', (msg, rinfo) => {
        try {
          const parsed = parseEnergyMeterTelegram(msg);
          if (!parsed) return;
          for (const h of this.handlers) {
            try { h(parsed, rinfo); } catch (_) { /* ignore handler errors */ }
          }
        } catch (_) {
          // ignore parse errors (traffic on same port)
        }
      });

      await new Promise((resolve, reject) => {
        sock.once('listening', resolve);
        sock.once('error', reject);
        sock.bind(this.port, '0.0.0.0');
      });

      // Join multicast group when configured. Some installations use unicast.
      if (isMulticastIp(this.multicastGroup)) {
        try {
          if (this.interfaceAddress) {
            sock.addMembership(this.multicastGroup, this.interfaceAddress);
          } else {
            sock.addMembership(this.multicastGroup);
          }
          this._logDebug(`[speedwire] Listening on ${this.multicastGroup}:${this.port}${this.interfaceAddress ? (' via ' + this.interfaceAddress) : ''}`);
        } catch (e) {
          // Still keep socket open – unicast may still work.
          this._logWarn(`[speedwire] Failed to join multicast group ${this.multicastGroup} (${_errMsg(e)}). Unicast may still work.`);
        }
      } else {
        this._logDebug(`[speedwire] Listening (unicast) on 0.0.0.0:${this.port}`);
      }

      this.started = true;
      this.starting = null;
    })();

    return await this.starting;
  }

  addHandler(fn) {
    if (typeof fn !== 'function') return () => {};
    this.handlers.add(fn);
    return () => {
      try { this.handlers.delete(fn); } catch (_) { /* ignore */ }
    };
  }

  async stopIfUnused() {
    if (this.handlers.size) return;
    if (!this.socket) return;

    const sock = this.socket;
    this.socket = null;
    this.started = false;
    this.starting = null;

    await new Promise((resolve) => {
      try { sock.close(() => resolve()); } catch (_) { resolve(); }
    });
  }
}

const _hubByKey = new Map();

function getHub(adapter, opts) {
  const port = Number(opts.port || 9522);
  const group = (opts.multicastGroup || '239.12.255.254').toString();
  const iface = (opts.interfaceAddress || '').toString().trim();
  const ns = adapter?.namespace || 'default';
  const key = `${ns}|${group}|${port}|${iface}`;
  let hub = _hubByKey.get(key);
  if (!hub) {
    hub = new SpeedwireHub(adapter, { port, multicastGroup: group, interfaceAddress: iface });
    _hubByKey.set(key, hub);
  }
  return { hub, key };
}


/**
 * Datapoint source schema (speedwire):
 *   {
 *     kind: 'speedwire',
 *     // Either OBIS addressing (recommended)
 *     obis: { c: 1, d: 4, e: 0, b: 0 },
 *     // or a header field
 *     field: 'susyId' | 'serialNumber' | 'timestampMs' | 'protocolId'
 *     // or a computed field
 *     computed: 'netActivePower' | 'netActiveEnergy'
 *   }
 */
class SpeedwireDriver {
  constructor(adapter, deviceCfg /*, template, globalCfg */) {
    this.adapter = adapter;
    this.cfg = deviceCfg;

    const c = this.cfg.connection || {};
    this.multicastGroup = (c.multicastGroup || '239.12.255.254').toString();
    this.port = Number(c.port || 9522);
    this.interfaceAddress = (c.interfaceAddress || '').toString().trim();

    // Optional: filter telegrams by source IP
    this.filterHost = (c.host || c.filterHost || '').toString().trim();

    // Mark device as disconnected if no telegram is received for this time.
    this.staleTimeoutMs = Number(c.staleTimeoutMs || 8000);

    this.unregister = null;
    this.hubKey = null;
    this.hub = null;

    this.lastSeen = 0;
    this.lastParsed = null;
  }

  async _ensureListener() {
    if (this.hub) return;

    const { hub, key } = getHub(this.adapter, {
      port: this.port,
      multicastGroup: this.multicastGroup,
      interfaceAddress: this.interfaceAddress,
    });

    this.hub = hub;
    this.hubKey = key;

    await this.hub.start();

    this.unregister = this.hub.addHandler((parsed, rinfo) => {
      try {
        if (this.filterHost && rinfo?.address && String(rinfo.address).trim() !== this.filterHost) return;

        // Only accept energy meter telegram payloads (0x6069 / 0x6081)
        if (parsed?.protocolId !== 0x6069 && parsed?.protocolId !== 0x6081) return;

        this.lastSeen = Date.now();
        this.lastParsed = parsed;
      } catch (_) {
        // ignore
      }
    });
  }

  async disconnect() {
    if (this.unregister) {
      try { this.unregister(); } catch (_) { /* ignore */ }
      this.unregister = null;
    }
    const key = this.hubKey;
    const hub = this.hub;
    this.hubKey = null;
    this.hub = null;

    // Try to stop the hub if nobody uses it anymore.
    try {
      if (hub) await hub.stopIfUnused();
    } catch (_) { /* ignore */ }

    // Cleanup global map if the hub stopped
    try {
      if (key && hub && !hub.socket) _hubByKey.delete(key);
    } catch (_) { /* ignore */ }
  }

  async writeDatapoint(/* dp, value */) {
    throw new Error('Speedwire driver is read-only (meter telegram listener).');
  }

  _getObisValue(src) {
    const parsed = this.lastParsed;
    if (!parsed) return undefined;

    const obis = src?.obis || {};
    const c = Number(obis.c);
    const d = Number(obis.d);
    const e = (obis.e !== undefined && obis.e !== null) ? Number(obis.e) : 0;
    const b = (obis.b !== undefined && obis.b !== null) ? Number(obis.b) : null;

    if (!Number.isFinite(c) || !Number.isFinite(d)) return undefined;
    const keyCde = `${c}.${d}.${e}`;
    if (b !== null && Number.isFinite(b)) {
      const keyBcde = `${b}:${keyCde}`;
      if (parsed.valuesByBcde?.has(keyBcde)) return parsed.valuesByBcde.get(keyBcde);
    }
    if (parsed.valuesByCde?.has(keyCde)) return parsed.valuesByCde.get(keyCde);
    return undefined;
  }

  _computeNetActivePower() {
    // kW: import - export
    const imp = this._getObisValue({ obis: { c: 1, d: 4, e: 0 } });
    const exp = this._getObisValue({ obis: { c: 2, d: 4, e: 0 } });
    const a = (typeof imp === 'number' && Number.isFinite(imp)) ? imp : 0;
    const b = (typeof exp === 'number' && Number.isFinite(exp)) ? exp : 0;
    return a - b;
  }

  _computeNetActiveEnergy() {
    // kWh: import - export
    const imp = this._getObisValue({ obis: { c: 1, d: 8, e: 0 } });
    const exp = this._getObisValue({ obis: { c: 2, d: 8, e: 0 } });
    const a = (typeof imp === 'number' && Number.isFinite(imp)) ? imp : 0;
    const b = (typeof exp === 'number' && Number.isFinite(exp)) ? exp : 0;
    return a - b;
  }

  async readDatapoints(datapoints) {
    await this._ensureListener();

    const now = Date.now();
    if (!this.lastParsed || !this.lastSeen) {
      const e = new Error(`Speedwire: no telegram received yet (group ${this.multicastGroup}:${this.port}${this.filterHost ? (', filter ' + this.filterHost) : ''}).`);
      e.code = 'E_SPEEDWIRE_NO_DATA';
      throw e;
    }

    if (this.staleTimeoutMs > 0 && (now - this.lastSeen) > this.staleTimeoutMs) {
      const e = new Error(`Speedwire: no telegram received for ${(now - this.lastSeen)} ms (stale timeout ${this.staleTimeoutMs} ms). Check multicast/IGMP and network path.`);
      e.code = 'E_SPEEDWIRE_STALE';
      throw e;
    }

    const parsed = this.lastParsed;
    const out = {};
    const dps = Array.isArray(datapoints) ? datapoints : [];
    for (const dp of dps) {
      const src = dp?.source || {};
      if (src.kind !== 'speedwire') continue;
      if (dp.rw === 'wo') continue;

      let val;

      if (src.field) {
        if (src.field === 'susyId') val = parsed.susyId;
        if (src.field === 'serialNumber') val = parsed.serialNumber;
        if (src.field === 'timestampMs') val = parsed.timestampMs;
        if (src.field === 'protocolId') val = parsed.protocolId;
      } else if (src.computed) {
        if (src.computed === 'netActivePower') val = this._computeNetActivePower();
        if (src.computed === 'netActiveEnergy') val = this._computeNetActiveEnergy();
      } else if (src.obis) {
        val = this._getObisValue(src);
      }

      if (val === undefined) continue;
      out[dp.id] = val;
    }

    return out;
  }
}

module.exports = {
  SpeedwireDriver,
  // exported for unit tests / diagnostics
  parseEnergyMeterTelegram,
  normalizeObisValue,
  findProtocolIdOffset,
  toHex,
};
