'use strict';

/*
  Modbus driver (RTU + TCP) with support for:
  - FC1/FC3/FC4 reads
  - FC5/FC6/FC16 writes
  - per-datapoint read/write mapping (source.read / source.write)
  - wordOrder (be/le) and byteOrder (be/le)
  - optional transforms: scaleFactor (10^n), invert, invertIfSetting, keepPositive, keepNegativeAndInvert
*/

const ModbusRTU = require('modbus-serial');
const { acquireBus, releaseBus } = require('./modbusRtuBus');
const { applyScale, removeScale, bigIntToNumberOrString } = require('../utils');

function normalizeWordOrder(v) {
  const s = (v ?? '').toString().toLowerCase();
  if (s === 'le' || s === 'little' || s === 'little_endian' || s === 'lswmsw' || s === 'lsw_msw') return 'le';
  return 'be';
}

function normalizeByteOrder(v) {
  const s = (v ?? '').toString().toLowerCase();
  if (s === 'le' || s === 'little' || s === 'little_endian') return 'le';
  return 'be';
}

function swapBytesInWords(buf) {
  // swap bytes inside each 16-bit register word
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const a = buf[i];
    buf[i] = buf[i + 1];
    buf[i + 1] = a;
  }
}

function regsToBuffer(regs, wordOrder, byteOrder) {
  const wo = normalizeWordOrder(wordOrder);
  const bo = normalizeByteOrder(byteOrder);

  const arr = Array.isArray(regs) ? regs.slice() : [];
  if (wo === 'le') arr.reverse();

  const buf = Buffer.alloc(arr.length * 2);
  for (let i = 0; i < arr.length; i++) {
    buf.writeUInt16BE(arr[i] & 0xFFFF, i * 2);
  }

  if (bo === 'le') swapBytesInWords(buf);
  return buf;
}

function bufferToRegs(buf, wordOrder, byteOrder) {
  const wo = normalizeWordOrder(wordOrder);
  const bo = normalizeByteOrder(byteOrder);

  const tmp = Buffer.from(buf); // copy
  if (bo === 'le') swapBytesInWords(tmp);

  const regs = [];
  for (let i = 0; i < tmp.length; i += 2) {
    regs.push(tmp.readUInt16BE(i));
  }

  if (wo === 'le') regs.reverse();
  return regs;
}

function bufferToValue(buf, dataType) {
  const t = (dataType || 'uint16').toString().toLowerCase();

  switch (t) {
    case 'bool':
    case 'boolean': {
      // Some devices store booleans in registers (uint16 0/1). In that case the buffer length is 2.
      if (buf.length >= 2) return buf.readUInt16BE(0) !== 0;
      return buf.readUInt8(0) !== 0;
    }

    case 'string':
    case 'ascii': {
      const s = buf.toString('ascii');
      const nul = s.indexOf('\0');
      return (nul >= 0 ? s.substring(0, nul) : s).trim();
    }

    case 'int16':
      return buf.readInt16BE(0);
    case 'uint16':
      return buf.readUInt16BE(0);
    case 'int32':
      return buf.readInt32BE(0);
    case 'uint32':
      return buf.readUInt32BE(0);
    case 'float32':
      return buf.readFloatBE(0);
    case 'int64':
      return buf.readBigInt64BE(0);
    case 'uint64':
      return buf.readBigUInt64BE(0);
    case 'float64':
      return buf.readDoubleBE(0);
    default:
      return buf.readUInt16BE(0);
  }
}

function valueToBuffer(value, dataType, byteLength) {
  const t = (dataType || 'uint16').toString().toLowerCase();
  const bl = Number(byteLength || 2);
  const buf = Buffer.alloc(bl);

  if (t === 'bool' || t === 'boolean') {
    // If this is a register (2 bytes), write a uint16 0/1. For coils (1 byte) write 0/1.
    if (bl >= 2) {
      buf.writeUInt16BE(value ? 1 : 0, 0);
    } else {
      buf.writeUInt8(value ? 1 : 0, 0);
    }
    return buf;
  }

  if (t === 'string' || t === 'ascii') {
    const s = (value === null || value === undefined) ? '' : String(value);
    buf.fill(0);
    buf.write(s, 0, Math.min(buf.length, Buffer.byteLength(s, 'ascii')), 'ascii');
    return buf;
  }

  // Use BigInt for 64-bit if user provides a string
  const asBigInt = (v) => {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    if (typeof v === 'string') {
      try { return BigInt(v); } catch (e) { return BigInt(0); }
    }
    return BigInt(0);
  };

  switch (t) {
    case 'int16':
      buf.writeInt16BE(Number(value), 0);
      break;
    case 'uint16':
      buf.writeUInt16BE(Number(value), 0);
      break;
    case 'int32':
      buf.writeInt32BE(Number(value), 0);
      break;
    case 'uint32':
      buf.writeUInt32BE(Number(value), 0);
      break;
    case 'float32':
      buf.writeFloatBE(Number(value), 0);
      break;
    case 'int64':
      buf.writeBigInt64BE(asBigInt(value), 0);
      break;
    case 'uint64':
      buf.writeBigUInt64BE(asBigInt(value), 0);
      break;
    case 'float64':
      buf.writeDoubleBE(Number(value), 0);
      break;
    default:
      buf.writeUInt16BE(Number(value), 0);
      break;
  }
  return buf;
}

function mergeModbusSource(root, override) {
  if (!root || root.kind !== 'modbus') return null;
  const merged = Object.assign({}, root, override || {});
  merged.kind = 'modbus';
  return merged;
}

function getReadSource(dp) {
  const src = dp?.source;
  if (!src || src.kind !== 'modbus') return null;
  const rs = src.read || src;
  if (!rs || rs.fc == null) return null;
  return mergeModbusSource(src, rs);
}

function getWriteSource(dp) {
  const src = dp?.source;
  if (!src || src.kind !== 'modbus') return null;
  const ws = src.write || src;
  if (!ws || ws.fc == null) return null;
  return mergeModbusSource(src, ws);
}

function buildGroups(items, maxRegs) {
  const max = Number(maxRegs || 120);

  const dps = (items || [])
    .map(item => {
      const addr = Number(item.addr);
      const len = Number(item.len || 1);
      return { ...item, addr, len, end: addr + len - 1 };
    })
    .sort((a, b) => a.addr - b.addr);

  const groups = [];
  let g = null;

  for (const item of dps) {
    if (!g) {
      g = { start: item.addr, end: item.end, items: [item] };
      continue;
    }

    const newEnd = Math.max(g.end, item.end);
    const span = newEnd - g.start + 1;

    if (span <= max) {
      g.end = newEnd;
      g.items.push(item);
    } else {
      groups.push(g);
      g = { start: item.addr, end: item.end, items: [item] };
    }
  }

  if (g) groups.push(g);
  return groups;
}

class ModbusDriver {
  constructor(adapter, deviceConfig, template, globalConfig) {
    this.adapter = adapter;
    this.device = deviceConfig;
    this.template = template;
    this.global = globalConfig || {};

    this.client = null; // TCP client
    this.rtuBus = null;
    this.rtuBusKey = null;

    if (deviceConfig.protocol === 'modbusTcp') {
      this.client = new ModbusRTU();
    }
    this.connected = false;
    this.connecting = false;
    this._busy = false;

    // Cache for dynamic scale factors (e.g. SunSpec *_SF registers)
    this._sfCache = new Map();

    const c = deviceConfig.connection || {};
    this.protocol = deviceConfig.protocol; // modbusTcp or modbusRtu
    // Treat 0 or invalid values as "use default" (the UI often uses 0 to mean "not set").
    const rawTimeout = (c.timeoutMs ?? this.global.modbusTimeoutMs ?? 2000);
    this.timeoutMs = Number(rawTimeout);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      this.timeoutMs = Number(this.global.modbusTimeoutMs ?? 2000);
      if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) this.timeoutMs = 2000;
    }

    // Keep manual vs. auto-discovered values separate.
    // - manualUnitId / manualAddressOffset come from the device config
    // - autoUnitId / autoAddressOffset can be discovered at runtime (e.g. SunSpec base scan)
    this.manualUnitId = Number(c.unitId ?? 1);
    this.autoUnitId = null;
    this.unitId = this.manualUnitId;

    this.manualAddressOffset = Number(c.addressOffset ?? this.global.registerAddressOffset ?? 0);
    this.autoAddressOffset = 0;

    // Optional driver hints from templates (best-effort)
    const hints = (template && template.driverHints && template.driverHints.modbus) ? template.driverHints.modbus : {};
    this._autoSunSpec = (hints.autoSunSpec === true) || (hints.sunspec === true);
    this._sunSpecTemplateBase = Number(hints.sunSpecTemplateBase ?? 40000);
    this._sunSpecScanBases = Array.isArray(hints.sunSpecScanBases) ? hints.sunSpecScanBases.map(Number) : null;
    this._sunSpecScanUnitIds = Array.isArray(hints.sunSpecScanUnitIds) ? hints.sunSpecScanUnitIds.map(Number) : null;
    this._sunSpecScanFcs = Array.isArray(hints.sunSpecScanFunctionCodes) ? hints.sunSpecScanFunctionCodes.map(Number) : null;
    this._sunSpecDiscovered = false;

    // Allow per-device override via connection settings
    if (typeof c.autoSunSpec === 'boolean') this._autoSunSpec = c.autoSunSpec;
    if (Number.isFinite(Number(c.sunSpecTemplateBase))) this._sunSpecTemplateBase = Number(c.sunSpecTemplateBase);

    this.wordOrder = normalizeWordOrder(c.wordOrder || 'be');
    this.byteOrder = normalizeByteOrder(c.byteOrder || 'be');
  }

  async connect() {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    const c = this.device.connection || {};
    try {
      if (this.protocol === 'modbusTcp') {
        const host = c.host;
        const port = Number(c.port || 502);
        if (!this.client) this.client = new ModbusRTU();
        await new Promise((resolve, reject) => {
          this.client.connectTCP(host, { port }, (err) => err ? reject(err) : resolve());
        });
        this.client.setID(this.unitId);
        this.client.setTimeout(this.timeoutMs);
      } else if (this.protocol === 'modbusRtu') {
        if (!this.rtuBus) {
          const { key, bus } = acquireBus(this.adapter, {
            path: c.path,
            baudRate: c.baudRate,
            parity: c.parity,
            dataBits: c.dataBits,
            stopBits: c.stopBits,
          });
          this.rtuBusKey = key;
          this.rtuBus = bus;
        }
        await this.rtuBus.ensureConnected();
      } else {
        throw new Error(`Unsupported Modbus protocol: ${this.protocol}`);
      }

      this.connected = true;
      this.adapter.log.info(`[${this.device.id}] Modbus connected (${this.protocol})`);

      // Optional SunSpec base / unit-id discovery (only when enabled via template hints).
      try {
        await this._maybeDiscoverSunSpec();
      } catch (e) {
        // Discovery must never break connectivity.
        this.adapter.log.debug(`[${this.device.id}] SunSpec discovery error: ${e && e.message ? e.message : e}`);
      }
    } finally {
      this.connecting = false;
    }
  }

  async disconnect() {
    try {
      if (this.protocol === 'modbusTcp') {
        if (this.client) {
          try { this.client.close(() => {}); } catch (_) {}
        }
      } else if (this.protocol === 'modbusRtu') {
        if (this.rtuBusKey) {
          releaseBus(this.rtuBusKey);
        }
        this.rtuBus = null;
        this.rtuBusKey = null;
      }
    } finally {
      this.connected = false;
    }
  }

  async ensureConnected() {
    if (this.connected) return true;
    try {
      await this.connect();
      return this.connected;
    } catch (e) {
      this.connected = false;
      throw e;
    }
  }

  _setUnitId(id) {
    const uid = Number(id);
    if (!Number.isFinite(uid) || uid < 0) return;
    this.unitId = uid;
    if (this.protocol === 'modbusTcp' && this.client && typeof this.client.setID === 'function') {
      try { this.client.setID(uid); } catch (_) {}
    }
  }

  _addr(src) {
    const a = Number(src?.address || 0);
    return a + this.manualAddressOffset + this.autoAddressOffset;
  }

  _isSunSpecSignature(regs) {
    if (!Array.isArray(regs) || regs.length < 2) return false;
    const r0 = Number(regs[0]) & 0xFFFF;
    const r1 = Number(regs[1]) & 0xFFFF;

    // "SunS" in two 16-bit registers (big-endian words): 0x5375 0x6E53
    if (r0 === 0x5375 && r1 === 0x6E53) return true;

    // Some devices may swap bytes inside the 16-bit words: 0x7553 0x536E
    if (r0 === 0x7553 && r1 === 0x536E) return true;

    return false;
  }

  async _maybeDiscoverSunSpec() {
    if (!this._autoSunSpec) return false;
    if (this._sunSpecDiscovered) return true;

    // Only do discovery once per runtime.
    this._sunSpecDiscovered = true;

    // Candidates (kept intentionally small to avoid long connect delays)
    const templateBase = Number.isFinite(this._sunSpecTemplateBase) ? this._sunSpecTemplateBase : 40000;

    const baseCandidates = (this._sunSpecScanBases && this._sunSpecScanBases.length)
      ? this._sunSpecScanBases
      : [templateBase, templateBase - 1, 0, 1];

    const unitCandidates = [];
    const pushUid = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      if (n < 0 || n > 247) return;
      if (!unitCandidates.includes(n)) unitCandidates.push(n);
    };
    pushUid(this.manualUnitId);

    // SMA note (field reality): some SMA devices expose SunSpec on a derived unitId.
    // Common case: SunSpec Unit-ID = (configured SMA Modbus Unit-ID) + 123.
    // Example: SMA unitId=3 -> SunSpec unitId=126.
    pushUid(this.manualUnitId + 123);
    // Common SMA / SunSpec unit IDs seen in the field
    pushUid(1);
    pushUid(3);
    pushUid(126);
    if (this._sunSpecScanUnitIds && this._sunSpecScanUnitIds.length) {
      for (const u of this._sunSpecScanUnitIds) pushUid(u);
    }

    const fcCandidates = (this._sunSpecScanFcs && this._sunSpecScanFcs.length)
      ? this._sunSpecScanFcs
      : [3, 4];

    const originalTimeout = this.timeoutMs;
    const discoveryTimeout = Math.min(1000, Math.max(300, originalTimeout));
    try {
      // Temporarily tighten timeout for discovery probes
      if (this.protocol === 'modbusTcp' && this.client && typeof this.client.setTimeout === 'function') {
        try { this.client.setTimeout(discoveryTimeout); } catch (_) {}
      }

      for (const uid of unitCandidates) {
        this._setUnitId(uid);

        for (const fc of fcCandidates) {
          for (const base of baseCandidates) {
            const b = Number(base);
            if (!Number.isFinite(b)) continue;
            const testAddr = b + this.manualAddressOffset;
            if (testAddr < 0 || testAddr > 65535) continue;

            try {
              let regs;
              if (fc === 3) {
                regs = (await this._mbReadHoldingRegisters(testAddr, 2)).data || [];
              } else if (fc === 4) {
                regs = (await this._mbReadInputRegisters(testAddr, 2)).data || [];
              } else {
                continue;
              }

              if (this._isSunSpecSignature(regs)) {
                // Compute only the *additional* offset beyond the manual offset.
                const autoOff = b - templateBase - this.manualAddressOffset;
                this.autoAddressOffset = autoOff;
                this.autoUnitId = uid;
                this.adapter.log.info(
                  `[${this.device.id}] SunSpec discovery: found 'SunS' at base=${b} (FC${fc}, unitId=${uid}). ` +
                  `Applying autoAddressOffset=${autoOff} (manualAddressOffset=${this.manualAddressOffset}).`
                );
                return true;
              }
            } catch (e) {
              // Ignore probe errors and continue scanning.
            }
          }
        }
      }

      this.adapter.log.debug(
        `[${this.device.id}] SunSpec discovery: signature not found. ` +
        `Keeping unitId=${this.unitId} and addressOffset(manual)=${this.manualAddressOffset}.`
      );
      return false;
    } finally {
      // Restore timeout
      if (this.protocol === 'modbusTcp' && this.client && typeof this.client.setTimeout === 'function') {
        try { this.client.setTimeout(originalTimeout); } catch (_) {}
      }
    }
  }

  async _mbReadCoils(start, len) {
    if (this.protocol === 'modbusRtu') return await this.rtuBus.readCoils(this.unitId, this.timeoutMs, start, len);
    return await this.client.readCoils(start, len);
  }

  async _mbReadDiscreteInputs(start, len) {
    if (this.protocol === 'modbusRtu') return await this.rtuBus.readDiscreteInputs(this.unitId, this.timeoutMs, start, len);
    return await this.client.readDiscreteInputs(start, len);
  }

  async _mbReadHoldingRegisters(start, len) {
    if (this.protocol === 'modbusRtu') return await this.rtuBus.readHoldingRegisters(this.unitId, this.timeoutMs, start, len);
    return await this.client.readHoldingRegisters(start, len);
  }

  async _mbReadInputRegisters(start, len) {
    if (this.protocol === 'modbusRtu') return await this.rtuBus.readInputRegisters(this.unitId, this.timeoutMs, start, len);
    return await this.client.readInputRegisters(start, len);
  }

  async _mbWriteCoil(addr, value) {
    if (this.protocol === 'modbusRtu') return await this.rtuBus.writeCoil(this.unitId, this.timeoutMs, addr, value);
    return await this.client.writeCoil(addr, value);
  }

  async _mbWriteCoils(addr, values) {
    if (this.protocol === 'modbusRtu') return await this.rtuBus.writeCoils(this.unitId, this.timeoutMs, addr, values);
    return await this.client.writeCoils(addr, values);
  }

  async _mbWriteRegister(addr, value) {
    if (this.protocol === 'modbusRtu') return await this.rtuBus.writeRegister(this.unitId, this.timeoutMs, addr, value);
    return await this.client.writeRegister(addr, value);
  }

  async _mbWriteRegisters(addr, values) {
    if (this.protocol === 'modbusRtu') return await this.rtuBus.writeRegisters(this.unitId, this.timeoutMs, addr, values);
    return await this.client.writeRegisters(addr, values);
  }

  // NOTE: _addr() has been moved up to include manual+auto offsets.

  _shouldInvert(settingKey) {
    if (!settingKey) return false;
    // allow either device.<key> or device.settings.<key>
    const direct = this.device?.[settingKey];
    if (typeof direct === 'boolean') return direct;
    const nested = this.device?.settings?.[settingKey];
    if (typeof nested === 'boolean') return nested;
    return false;
  }


_getScaleFactor(src) {
  if (!src) return 0;

  // Dynamic scale factor via reference (e.g. SunSpec <X>_SF)
  if (src.scaleFactorRef) {
    const key = String(src.scaleFactorRef);
    const cached = this._sfCache.get(key);
    const n = Number(cached);
    // SunSpec uses 0x8000 (-32768) as "not implemented" for int16
    if (!Number.isNaN(n) && n !== -32768) return n;
  }

  const n = Number(src.scaleFactor || 0);
  return Number.isNaN(n) ? 0 : n;
}

  _applyTransforms(value, src) {
    if (typeof value !== 'number' || Number.isNaN(value)) return value;

    let v = value;

    // scaleFactor is applied on read direction (Element -> Channel)
    const sf = this._getScaleFactor(src);
    if (sf) v = applyScale(v, sf);

    if (src.invert === true) v = -v;
    if (src.invertIfSetting && this._shouldInvert(src.invertIfSetting)) v = -v;

    if (src.keepPositive === true) v = Math.max(0, v);
    if (src.keepNegativeAndInvert === true) v = v < 0 ? (-v) : 0;

    return v;
  }

async readDatapoints(datapoints) {
  if (this._busy) return {}; // skip overlapping polls
  this._busy = true;

  const out = {};

  // Keep numeric raw values separate so we can apply dynamic scale factors after all reads.
  const numRawById = {};
  const srcById = {};

  try {
    await this.ensureConnected();

    const readItems = (datapoints || []).map(dp => {
      const src = getReadSource(dp);
      if (!src) return null;
      const fc = Number(src.fc);
      if (![1, 2, 3, 4].includes(fc)) return null;
      const addr = this._addr(src);
      const len = Number(src.length || 1);
      return { dp, src, addr, len, fc };
    }).filter(Boolean);

    // Collect all referenced scale factor datapoints (e.g. <X>_SF)
    const scaleFactorRefs = new Set();
    for (const it of readItems) {
      if (it?.src?.scaleFactorRef) scaleFactorRefs.add(String(it.src.scaleFactorRef));
    }

    const byFc = new Map();
    for (const it of readItems) {
      const fc = Number(it.fc);
      if (!byFc.has(fc)) byFc.set(fc, []);
      byFc.get(fc).push(it);
    }

    for (const [fc, items] of byFc.entries()) {
      if (fc === 1) {
        // Coils
        const groups = buildGroups(items, 2000);
        for (const g of groups) {
          const len = g.end - g.start + 1;
          const res = await this._mbReadCoils(g.start, len);
          const bits = res.data || [];
          for (const item of g.items) {
            const off = item.addr - g.start;
            out[item.dp.id] = !!bits[off];
          }
        }
        continue;
      }

      if (fc === 2) {
        // Discrete inputs
        const groups = buildGroups(items, 2000);
        for (const g of groups) {
          const len = g.end - g.start + 1;
          const res = await this._mbReadDiscreteInputs(g.start, len);
          const bits = res.data || [];
          for (const item of g.items) {
            const off = item.addr - g.start;
            out[item.dp.id] = !!bits[off];
          }
        }
        continue;
      }

      // Registers
      const groups = buildGroups(items, 120);
      for (const g of groups) {
        const len = g.end - g.start + 1;

        let regs;
        if (fc === 3) {
          regs = (await this._mbReadHoldingRegisters(g.start, len)).data || [];
        } else {
          regs = (await this._mbReadInputRegisters(g.start, len)).data || [];
        }

        for (const item of g.items) {
          const dp = item.dp;
          const src = item.src;

          const off = item.addr - g.start;
          const slice = regs.slice(off, off + Number(src.length || 1));

          const wo = src.wordOrder || this.wordOrder;
          const bo = src.byteOrder || this.byteOrder;
          const buf = regsToBuffer(slice, wo, bo);
          let raw = bufferToValue(buf, src.dataType);

          // Convert BigInt safely: use Number if within safe range, else keep as string.
          // If it becomes a Number we treat it like any other numeric value so scaling/transforms work.
          if (typeof raw === 'bigint') {
            const conv = bigIntToNumberOrString(raw);
            if (typeof conv === 'string') {
              out[dp.id] = conv;
              continue;
            }
            raw = conv; // safe number
          }

          if (typeof raw === 'boolean') {
            out[dp.id] = raw;
            continue;
          }

          if (typeof raw === 'string') {
            out[dp.id] = raw;
            continue;
          }

          // number (store raw for later scaling/transform)
          const n = Number(raw);
          if (!Number.isNaN(n)) {
            numRawById[dp.id] = n;
            srcById[dp.id] = src;
          }
        }
      }
    }

    // Update dynamic scale-factor cache first (order-independent)
    for (const [dpId, raw] of Object.entries(numRawById)) {
      if (dpId.endsWith('_SF')) {
        // SunSpec uses 0x8000 (-32768) as "not implemented" for int16
        if (raw !== -32768) this._sfCache.set(dpId, raw);
      }
    }
    for (const ref of scaleFactorRefs) {
      const raw = numRawById[ref];
      if (typeof raw === 'number' && !Number.isNaN(raw) && raw !== -32768) {
        this._sfCache.set(ref, raw);
      }
    }

    // Apply numeric transforms (including dynamic scaling) now that SF cache is up-to-date
    for (const [dpId, raw] of Object.entries(numRawById)) {
      const src = srcById[dpId] || {};
      out[dpId] = this._applyTransforms(raw, src);
    }
  } finally {
    this._busy = false;
  }

  return out;
}

  async writeDatapoint(dp, value) {
    await this.ensureConnected();

    const src = getWriteSource(dp);
    if (!src) throw new Error('Datapoint has no Modbus write source');

    const fc = Number(src.fc);
    const addr = this._addr(src);

    if (fc === 5) {
      await this._mbWriteCoil(addr, !!value);
      return;
    }

    if (fc === 15) {
      // Write multiple coils (we support single-coil use as well)
      await this._mbWriteCoils(addr, [!!value]);
      return;
    }

    // Prepare numeric value for register writes
    let raw = value;
    if (typeof raw === 'string' && raw.trim() !== '') {
      // allow numeric strings
      const n = Number(raw);
      if (!Number.isNaN(n)) raw = n;
    }

    // Undo scaling for write direction (Channel -> Element)
    if (typeof raw === 'number') {
      const sf = this._getScaleFactor(src);
      if (sf) raw = removeScale(raw, sf);
    }

    const wo = src.wordOrder || this.wordOrder;
    const bo = src.byteOrder || this.byteOrder;

    const words = Number(src.length || 1);
    const buf = valueToBuffer(raw, src.dataType, words * 2);
    const regs = bufferToRegs(buf, wo, bo);

    if (fc === 6) {
      if (regs.length < 1) throw new Error('FC6 requires one register');
      await this._mbWriteRegister(addr, regs[0]);
      return;
    }

    if (fc === 16) {
      await this._mbWriteRegisters(addr, regs);
      return;
    }

    throw new Error(`Unsupported write FC=${fc}`);
  }
}

module.exports = { ModbusDriver };
