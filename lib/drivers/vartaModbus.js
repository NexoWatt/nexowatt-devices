'use strict';

const { performance } = require('node:perf_hooks');
const { ModbusDriver } = require('./modbus');
const { TABLE_VERSION, getVartaProfile, registersForProfile, decodeWords, scaleValue, buildReadGroups } = require('../vartaProtocol');

// A VARTA server accepts arbitrary Unit-IDs. Multiple configured devices at one
// host must therefore share pacing AND transaction ordering, not merely a UID.
// Other manufacturers keep their existing Modbus driver entirely unchanged.
const endpoints = new Map();
const NOTE = 'Public table 14 documents monitoring and scale-factor configuration only; no charge/discharge setpoint or external enable.';
function error(code, message) { return Object.assign(new Error(message), { code }); }
function isRegisterException(e) {
  const code = Number(e && (e.modbusCode ?? e.exceptionCode));
  return [1, 2, 3].includes(code) || /illegal (data )?(address|value|function)|modbus exception [123]\b/i.test(String(e?.message || ''));
}

/**
 * Dedicated public-14 implementation; inherits only the proven TCP transport,
 * reconnect/backoff and hard timeouts. No generic password unlock, SunSpec scan,
 * off-by-one probing, FC16 fallback or automatic control writes are used here.
 */
class VartaModbusDriver extends ModbusDriver {
  constructor(adapter, device, template, globalConfig) {
    super(adapter, device, template, globalConfig);
    this.profile = getVartaProfile(template);
    if (!this.profile || device.protocol !== 'modbusTcp') throw error('E_VARTA_PROFILE', 'VARTA public table 14 requires its matching Modbus TCP profile');
    this.registers = registersForProfile(this.profile);
    this.byId = new Map(this.registers.map(def => [def.id, def]));
    this.manualAddressOffset = 0;
    this.autoAddressOffset = 0;
    this._autoSunSpec = false;
    this.disableAddressFallbackOffsets = true;
    this._disableAddressFallbackOffsets = true;
    // The per-endpoint scheduler below enforces the vendor minimum even if the
    // user enters 0 ms. Waiting is OUTSIDE the TCP operation hard timeout.
    this.minRequestIntervalMs = Math.max(this.profile.minIntervalMs, Number(this.minCommandIntervalMs) || 0);
    this.minCommandIntervalMs = 0;
    this.maxReadRegs = Math.max(25, Math.min(125, Math.trunc(this.maxReadRegs || 40)));
    const configuredUnit = device.connection?.unitId;
    if (configuredUnit !== undefined && configuredUnit !== null && configuredUnit !== '' && (!Number.isInteger(Number(configuredUnit)) || Number(configuredUnit) < 1 || Number(configuredUnit) > 255)) {
      throw error('E_VARTA_UNIT_ID', 'VARTA Modbus TCP Unit-ID must be an integer from 1 to 255 (recommended: 255)');
    }
    this.unitId = configuredUnit === undefined || configuredUnit === null || configuredUnit === '' ? 255 : Number(configuredUnit);
    this.manualUnitId = this.unitId;
    this._endpointKey = `${String(device.connection?.host || '').trim().toLowerCase()}:${Number(device.connection?.port || 502)}`;
    let endpoint = endpoints.get(this._endpointKey);
    if (!endpoint) {
      endpoint = { tail: Promise.resolve(), lastAt: null, lastInterval: 0, refs: 0, pending: 0 };
      endpoints.set(this._endpointKey, endpoint);
    }
    endpoint.refs += 1;
    this._endpoint = endpoint;
    this._stopped = false;
    this._epoch = 0;
    this._activeEpoch = 0;
    this._sleepCancels = new Set();
    this._pendingWrites = 0;
    this._readPending = null;
    this._lastDiagnostic = '';
  }

  _assertActive(epoch = this._epoch) {
    if (this._stopped) throw error('E_VARTA_STOPPED', 'VARTA operation cancelled: device runtime stopped');
    if (epoch !== this._epoch) throw error('E_VARTA_RESET', 'VARTA operation cancelled after transport reset; no queued command replay');
  }

  _now() { return performance.now(); }
  _delay(ms) {
    return new Promise((resolve, reject) => {
      const cancel = reason => { clearTimeout(timer); this._sleepCancels.delete(cancel); reject(reason || error('E_VARTA_STOPPED', 'VARTA pacing wait cancelled')); };
      const timer = setTimeout(() => { this._sleepCancels.delete(cancel); resolve(); }, ms);
      this._sleepCancels.add(cancel);
    });
  }

  _releaseEndpointIfUnused() {
    if (!this._endpoint.refs && !this._endpoint.pending && endpoints.get(this._endpointKey) === this._endpoint) endpoints.delete(this._endpointKey);
  }

  async connect() {
    const epoch = this._epoch;
    this._assertActive(epoch);
    await super.connect();
    if (this._stopped || epoch !== this._epoch) {
      await super.disconnect();
      this._assertActive(epoch);
    }
  }

  async resetTransport() {
    // DeviceRuntime uses this on a transport fault. Unlike terminal disconnect,
    // it MUST preserve the driver for the next automatic poll/reconnect. Drop
    // commands queued before the reset instead of replaying expert SF writes.
    this._epoch += 1;
    this._readPending = null;
    const reason = error('E_VARTA_RESET', 'VARTA pacing wait cancelled after transport reset');
    for (const cancel of [...this._sleepCancels]) cancel(reason);
    await super.disconnect();
  }

  async disconnect() {
    if (!this._stopped) {
      this._stopped = true;
      for (const cancel of [...this._sleepCancels]) cancel();
      this._endpoint.refs -= 1;
      this._releaseEndpointIfUnused();
    }
    await super.disconnect();
  }

  _transaction(fn) {
    this._assertActive();
    const ep = this._endpoint;
    const epoch = this._epoch;
    ep.pending += 1;
    const run = ep.tail.catch(() => {}).then(async () => {
      this._assertActive(epoch);
      await this.ensureConnected();
      this._assertActive(epoch);
      this._activeEpoch = epoch;
      return fn();
    });
    const settled = run.finally(() => { ep.pending -= 1; this._releaseEndpointIfUnused(); });
    ep.tail = settled.catch(() => {});
    return settled;
  }

  async _request(fn) {
    const epoch = this._activeEpoch;
    this._assertActive(epoch);
    const ep = this._endpoint;
    // Also respect the preceding request's limit (e.g. link + another profile
    // accidentally configured against the same endpoint).
    const interval = Math.max(this.minRequestIntervalMs, ep.lastInterval);
    while (ep.lastAt !== null && this._now() < ep.lastAt + interval) {
      await this._delay(Math.max(1, Math.ceil(ep.lastAt + interval - this._now())));
      this._assertActive(epoch);
    }
    ep.lastAt = this._now();
    ep.lastInterval = this.minRequestIntervalMs;
    const result = await fn();
    this._assertActive(epoch);
    return result;
  }

  async _readWords(address, length) {
    const response = await this._request(() => super._mbReadHoldingRegisters(address, length, this.unitId));
    const words = response?.data;
    if (!Array.isArray(words) || words.length !== length || words.some(w => !Number.isInteger(w) || w < 0 || w > 65535)) {
      throw error('E_VARTA_RESPONSE', `VARTA short/invalid FC3 response at ${address}: expected ${length} registers`);
    }
    return words;
  }

  _diagnostics(out, notes, supported, scalingValid) {
    out['diagnostics.tableSupported'] = supported;
    out['diagnostics.scalingValid'] = supported && scalingValid;
    out['diagnostics.externalControlSupported'] = false;
    out['diagnostics.scaleFactorWritesEnabled'] = this.profile.scaled && this.device.vartaAllowScaleFactorWrites === true;
    out['diagnostics.note'] = [...notes, NOTE].join(' ');
    const diagnostic = notes.join(' ');
    if (diagnostic !== this._lastDiagnostic) {
      this._lastDiagnostic = diagnostic;
      if (diagnostic) this.adapter.log.warn(`[${this.device.id}] VARTA: ${diagnostic}`);
    }
    return out;
  }

  async readDatapoints(datapoints) {
    // Coalesce duplicate read callers rather than building an unbounded poll
    // queue or returning an empty snapshot that looks like fresh device data.
    if (this._readPending) return this._readPending;
    const promise = this._transaction(() => this._readSnapshot(datapoints));
    this._readPending = promise;
    try { return await promise; } finally { if (this._readPending === promise) this._readPending = null; }
  }

  async _readSnapshot(datapoints) {
    const requestedIds = new Set((datapoints || this.template.datapoints).map(dp => String(dp.id)));
    const selected = this.registers.filter(def => requestedIds.has(def.id));
    const out = {};
    const notes = [];
    // Read the table version from the literal documented address before using
    // the map. The PDF explicitly does not guarantee backwards compatibility.
    const version = (await this._readWords(1051, 1))[0];
    out.tABLE_VERSION = version;
    if (version !== TABLE_VERSION) {
      // Null ALL measurements, not just requested ones, to retire an old good
      // snapshot immediately after a firmware/table change. Do not guess a map.
      for (const def of this.registers) if (def.id !== 'tABLE_VERSION') out[def.id] = null;
      return this._diagnostics(out, [`Unsupported table version ${version}; expected 14. Measurement interpretation and all writes are blocked.`], false, false);
    }

    const readDefs = new Map(selected.filter(def => def.id !== 'tABLE_VERSION').map(def => [def.id, def]));
    for (const def of selected) {
      if (def.sf && this.profile.scaled) readDefs.set(def.sf, this.byId.get(def.sf));
    }
    const raw = { tABLE_VERSION: version };
    for (const group of buildReadGroups([...readDefs.values()], this.maxReadRegs)) {
      try {
        const words = await this._readWords(group.start, group.end - group.start + 1);
        for (const def of group.definitions) {
          const offset = def.address - group.start;
          raw[def.id] = decodeWords(words.slice(offset, offset + def.length), def);
        }
      } catch (e) {
        // An unsupported optional register is visible as null, never fabricated
        // zero or an old cached SF. Core failures and all transport/short-frame
        // errors fail the poll, so the normal runtime connection failsafe acts.
        if (!isRegisterException(e) || group.definitions.some(def => def.core)) throw e;
        for (const def of group.definitions) raw[def.id] = null;
        notes.push(`FC3 ${group.start}-${group.end} unavailable (${group.definitions.map(def => def.id).join(', ')}).`);
      }
    }
    let scalingValid = true;
    for (const def of readDefs.values()) {
      const value = raw[def.id];
      if (value === undefined || value === null) {
        out[def.id] = null;
        if (def.writable) scalingValid = false;
      } else if (def.dataType === 'string16' || def.writable) {
        out[def.id] = value;
      } else {
        const exponent = def.sf && this.profile.scaled ? raw[def.sf] : 0;
        out[def.id] = scaleValue(value, exponent, def.scaleFactor || 0);
        if (out[def.id] === null) {
          scalingValid = false;
          notes.push(`Invalid/missing scale exponent for ${def.id}; value unavailable.`);
        }
        if (def.id === 'sOC' && out[def.id] !== null && (out[def.id] < 0 || out[def.id] > 100)) {
          out[def.id] = null;
          notes.push('SOC outside documented 0..100 percent; value unavailable.');
        }
      }
    }
    return this._diagnostics(out, notes, true, scalingValid);
  }

  async writeDatapoint(dp, value) {
    // Authoritative model-specific allowlist, NOT a caller-provided FC/address.
    // Only explicitly selected SF configuration writes are permitted.
    const def = this.byId.get(String(dp?.id || ''));
    if (!def?.writable || !this.profile.scaled) throw error('E_VARTA_READ_ONLY', `VARTA ${dp?.id || 'datapoint'} is not a documented writable scale-factor register`);
    if (this.device.vartaAllowScaleFactorWrites !== true) throw error('E_VARTA_WRITE_LOCKED', 'VARTA scale-factor writes are locked. Explicitly enable the expert option; these registers do not control charging.');
    const numericString = typeof value === 'string' && /^[+-]?\d+$/.test(value.trim());
    const number = typeof value === 'number' || numericString ? Number(value) : NaN;
    if (!Number.isInteger(number) || number < -32768 || number > 32767) throw error('E_VARTA_WRITE_VALUE', 'VARTA scale factor requires a signed 16-bit integer (-32768..32767)');
    // Full SINT16 is documented. Do not invent a narrower vendor range; invalid
    // engineering exponents are instead clearly rejected by the read decoder.
    if (this._pendingWrites >= 8) throw error('E_VARTA_WRITE_BUSY', 'VARTA scale-factor configuration queue is full; wait for readback before issuing another write');
    this._pendingWrites += 1;
    try {
      return await this._transaction(async () => {
        // Recheck the opt-in when dequeued, not only when originally submitted.
        if (this.device.vartaAllowScaleFactorWrites !== true) throw error('E_VARTA_WRITE_LOCKED', 'VARTA scale-factor write permission was revoked');
        const identity = await this._readWords(1051, 13); // table + timestamp + serial only; supported on every model
        const serial = decodeWords(identity.slice(3, 13), this.byId.get('sERIAL_NUMBER'));
        if (identity[0] !== TABLE_VERSION || !/^\d{9}$/.test(serial)) {
          throw error('E_VARTA_WRITE_IDENTITY', `VARTA write blocked: expected table 14 and a 9-digit serial number at FC3@1051/1054; got table ${identity[0]} and ${JSON.stringify(serial)}`);
        }
        await this._readWords(def.address, 1); // target must exist; never scan neighbouring addresses
        const encoded = number < 0 ? number + 65536 : number;
        await this._request(() => super._mbWriteRegister(def.address, encoded, this.unitId)); // FC6 ONLY
        const actual = decodeWords(await this._readWords(def.address, 1), def);
        if (actual !== number) throw error('E_VARTA_WRITE_VERIFY', `VARTA FC6@${def.address} readback mismatch: requested ${number}, read ${actual}; no automatic retry`);
        // No scale cache exists: the next snapshot re-reads every needed SF and
        // mantissa together. Runtime acknowledges only after this confirmation.
      });
    } finally {
      this._pendingWrites -= 1;
    }
  }
}

module.exports = { VartaModbusDriver };
