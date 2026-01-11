'use strict';

const ModbusRTU = require('modbus-serial');
const { applyScale, removeScale, bigIntToNumberOrString } = require('../utils');

function normalizeWordOrder(wordOrder) {
  const w = (wordOrder || '').toString().toLowerCase();
  if (w === 'le' || w === 'little' || w === 'littleendian' || w === 'little-endian') return 'le';
  // default big-endian word order (first register = high word)
  return 'be';
}

function regsToBuffer(regs, wordOrder) {
  const order = normalizeWordOrder(wordOrder);
  const r = Array.isArray(regs) ? regs.slice() : [];
  if (order === 'le') r.reverse();
  const buf = Buffer.alloc(r.length * 2);
  for (let i = 0; i < r.length; i++) {
    buf.writeUInt16BE(r[i] & 0xFFFF, i * 2);
  }
  return buf;
}

function bufferToValue(buf, dataType) {
  switch ((dataType || '').toLowerCase()) {
    case 'bool':
      return !!buf.readUInt8(0);
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
      // fallback: uint16
      return buf.readUInt16BE(0);
  }
}

function valueToBuffer(value, dataType, byteLength) {
  const buf = Buffer.alloc(byteLength);
  switch ((dataType || '').toLowerCase()) {
    case 'int16':
      buf.writeInt16BE(Math.trunc(Number(value) || 0), 0);
      break;
    case 'uint16':
      buf.writeUInt16BE(Math.trunc(Number(value) || 0), 0);
      break;
    case 'int32':
      buf.writeInt32BE(Math.trunc(Number(value) || 0), 0);
      break;
    case 'uint32':
      buf.writeUInt32BE(Math.trunc(Number(value) || 0), 0);
      break;
    case 'float32':
      buf.writeFloatBE(Number(value) || 0, 0);
      break;
    case 'int64': {
      const bi = (typeof value === 'bigint') ? value : BigInt(Math.trunc(Number(value) || 0));
      buf.writeBigInt64BE(bi, 0);
      break;
    }
    case 'uint64': {
      const bi = (typeof value === 'bigint') ? value : BigInt(Math.trunc(Number(value) || 0));
      buf.writeBigUInt64BE(bi, 0);
      break;
    }
    case 'float64':
      buf.writeDoubleBE(Number(value) || 0, 0);
      break;
    default:
      buf.writeUInt16BE(Math.trunc(Number(value) || 0), 0);
      break;
  }
  return buf;
}

function bufferToRegs(buf, wordOrder) {
  const regs = [];
  for (let i = 0; i < buf.length; i += 2) {
    regs.push(buf.readUInt16BE(i));
  }
  const order = normalizeWordOrder(wordOrder);
  if (order === 'le') regs.reverse();
  return regs;
}

function buildGroups(datapoints, maxRegs) {
  const dps = datapoints
    .map(dp => {
      const src = dp.source || {};
      const addr = Number(src.address);
      const len = Number(src.length || 1);
      return { dp, addr, len, end: addr + len - 1 };
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
    const newLen = (newEnd - g.start + 1);

    if (item.addr <= g.end + 1 && newLen <= maxRegs) {
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
    this.wordOrder = c.wordOrder || 'be';
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

  _addr(dp) {
    const src = dp.source || {};
    const a = Number(src.address || 0);
    return a + this.addressOffset;
  }

  async readDatapoints(datapoints) {
    if (this._busy) return {}; // skip overlapping polls
    this._busy = true;
    const out = {};

    try {
      await this.ensureConnected();

      const readDps = datapoints.filter(dp => {
        const src = dp.source || {};
        const fc = Number(src.fc);
        return src.kind === 'modbus' && (fc === 1 || fc === 3 || fc === 4);
      });

      // group per function code
      const byFc = {};
      for (const dp of readDps) {
        const fc = Number(dp.source.fc);
        byFc[fc] = byFc[fc] || [];
        byFc[fc].push(dp);
      }

      // Registers (FC3/FC4)
      for (const fcStr of Object.keys(byFc)) {
        const fc = Number(fcStr);
        if (fc !== 3 && fc !== 4 && fc !== 1) continue;

        const dpsFc = byFc[fc];

        if (fc === 1) {
          // coils
          const groups = buildGroups(dpsFc, 2000); // bits
          for (const g of groups) {
            const start = g.start + this.addressOffset;
            const len = g.end - g.start + 1;
            const res = await this.client.readCoils(start, len);
            const bits = (res && res.data) ? res.data : [];
            for (const item of g.items) {
              const dp = item.dp;
              const offset = item.addr - g.start;
              const val = !!bits[offset];
              out[dp.id] = val;
            }
          }
          continue;
        }

        const groups = buildGroups(dpsFc, 120); // max 125 regs typical; keep margin
        for (const g of groups) {
          const start = g.start + this.addressOffset;
          const len = g.end - g.start + 1;

          let res;
          if (fc === 3) {
            res = await this.client.readHoldingRegisters(start, len);
          } else {
            res = await this.client.readInputRegisters(start, len);
          }

          const regs = (res && res.data) ? res.data : [];

          for (const item of g.items) {
            const dp = item.dp;
            const src = dp.source || {};
            const offset = item.addr - g.start;
            const slice = regs.slice(offset, offset + Number(src.length || 1));
            const buf = regsToBuffer(slice, this.wordOrder);
            let raw = bufferToValue(buf, src.dataType);

            // BigInt handling
            if (typeof raw === 'bigint') {
              const safe = bigIntToNumberOrString(raw);
              if (typeof safe === 'number') {
                raw = safe;
              } else {
                // keep as string; scaling not applied
                out[dp.id] = safe;
                continue;
              }
            }

            const scaled = applyScale(Number(raw), src.scaleFactor || 0);
            out[dp.id] = scaled;
          }
        }
      }

      return out;
    } catch (e) {
      this.connected = false;
      throw e;
    } finally {
      this._busy = false;
    }
  }

  async writeDatapoint(dp, value) {
    const src = dp.source || {};
    if (src.kind !== 'modbus') throw new Error('writeDatapoint: not a modbus datapoint');

    const fc = Number(src.fc);
    if (![5, 6, 16].includes(fc)) {
      throw new Error(`writeDatapoint: unsupported function code FC${fc}`);
    }

    await this.ensureConnected();

    const addr = this._addr(dp);

    if (fc === 5) {
      const v = !!value;
      await this.client.writeCoil(addr, v);
      return;
    }

    // scale back before writing
    let raw = value;
    if (typeof raw === 'string' && raw.trim() !== '' && !isNaN(Number(raw))) raw = Number(raw);
    if (typeof raw === 'number') raw = removeScale(raw, src.scaleFactor || 0);

    const byteLength = Number(src.length || 1) * 2;
    const buf = valueToBuffer(raw, src.dataType, byteLength);
    const regs = bufferToRegs(buf, this.wordOrder);

    if (fc === 6) {
      if (regs.length !== 1) {
        // If template says doubleword etc but FC6 cannot write multiple regs -> fallback to FC16
        await this.client.writeRegisters(addr, regs);
      } else {
        await this.client.writeRegister(addr, regs[0]);
      }
      return;
    }

    if (fc === 16) {
      await this.client.writeRegisters(addr, regs);
    }
  }
}

module.exports = {
  ModbusDriver,
};