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
const { applyScale, removeScale } = require('../utils');

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
    case 'boolean':
      return buf.readUInt8(0) !== 0;
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
    buf.writeUInt8(value ? 1 : 0, 0);
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

    this.client = new ModbusRTU();
    this.connected = false;
    this.connecting = false;
    this._busy = false;

    const c = deviceConfig.connection || {};
    this.protocol = deviceConfig.protocol; // modbusTcp or modbusRtu
    this.timeoutMs = Number(c.timeoutMs ?? this.global.modbusTimeoutMs ?? 2000);
    this.unitId = Number(c.unitId ?? 1);
    this.addressOffset = Number(c.addressOffset ?? this.global.registerAddressOffset ?? 0);

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
        await new Promise((resolve, reject) => {
          this.client.connectTCP(host, { port }, (err) => err ? reject(err) : resolve());
        });
      } else if (this.protocol === 'modbusRtu') {
        const path = c.path;
        const baudRate = Number(c.baudRate || 9600);
        const parity = (c.parity || 'none').toString();
        const dataBits = Number(c.dataBits || 8);
        const stopBits = Number(c.stopBits || 1);

        await new Promise((resolve, reject) => {
          this.client.connectRTUBuffered(path, { baudRate, parity, dataBits, stopBits }, (err) => err ? reject(err) : resolve());
        });
      } else {
        throw new Error(`Unsupported Modbus protocol: ${this.protocol}`);
      }

      this.client.setID(this.unitId);
      this.client.setTimeout(this.timeoutMs);

      this.connected = true;
      this.adapter.log.info(`[${this.device.id}] Modbus connected (${this.protocol})`);
    } finally {
      this.connecting = false;
    }
  }

  async disconnect() {
    try {
      this.client.close(() => {});
    } catch (e) {
      // ignore
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

  _addr(src) {
    const a = Number(src?.address || 0);
    return a + this.addressOffset;
  }

  _shouldInvert(settingKey) {
    if (!settingKey) return false;
    // allow either device.<key> or device.settings.<key>
    const direct = this.device?.[settingKey];
    if (typeof direct === 'boolean') return direct;
    const nested = this.device?.settings?.[settingKey];
    if (typeof nested === 'boolean') return nested;
    return false;
  }

  _applyTransforms(value, src) {
    if (typeof value !== 'number' || Number.isNaN(value)) return value;

    let v = value;

    // scaleFactor is applied on read direction (Element -> Channel)
    const sf = Number(src.scaleFactor || 0);
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

    try {
      await this.ensureConnected();

      const readItems = (datapoints || []).map(dp => {
        const src = getReadSource(dp);
        if (!src) return null;
        const fc = Number(src.fc);
        if (![1, 3, 4].includes(fc)) return null;
        const addr = this._addr(src);
        const len = Number(src.length || 1);
        return { dp, src, addr, len, fc };
      }).filter(Boolean);

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
            const res = await this.client.readCoils(g.start, len);
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
            regs = (await this.client.readHoldingRegisters(g.start, len)).data || [];
          } else {
            regs = (await this.client.readInputRegisters(g.start, len)).data || [];
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

            // BigInt -> string to avoid precision loss in ioBroker JSON/state
            if (typeof raw === 'bigint') {
              out[dp.id] = raw.toString();
              continue;
            }

            if (typeof raw === 'boolean') {
              out[dp.id] = raw;
              continue;
            }

            // number
            const val = this._applyTransforms(Number(raw), src);
            out[dp.id] = val;
          }
        }
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
      await this.client.writeCoil(addr, !!value);
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
      const sf = Number(src.scaleFactor || 0);
      if (sf) raw = removeScale(raw, sf);
    }

    const wo = src.wordOrder || this.wordOrder;
    const bo = src.byteOrder || this.byteOrder;

    const words = Number(src.length || 1);
    const buf = valueToBuffer(raw, src.dataType, words * 2);
    const regs = bufferToRegs(buf, wo, bo);

    if (fc === 6) {
      if (regs.length < 1) throw new Error('FC6 requires one register');
      await this.client.writeRegister(addr, regs[0]);
      return;
    }

    if (fc === 16) {
      await this.client.writeRegisters(addr, regs);
      return;
    }

    throw new Error(`Unsupported write FC=${fc}`);
  }
}

module.exports = { ModbusDriver };
