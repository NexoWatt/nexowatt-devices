'use strict';

/*
  Modbus driver (RTU + ASCII + TCP) with support for:
  - FC1/FC3/FC4 reads
  - FC5/FC6/FC16 writes
  - per-datapoint read/write mapping (source.read / source.write)
  - wordOrder (be/le) and byteOrder (be/le)
  - optional transforms: scaleFactor (10^n), invert, invertIfSetting, keepPositive, keepNegativeAndInvert
*/

const ModbusRTU = require('modbus-serial');
const { acquireBus, releaseBus } = require('./modbusRtuBus');
const { acquireBus: acquireAsciiBus, releaseBus: releaseAsciiBus } = require('./modbusAsciiBus');
const { applyScale, removeScale, bigIntToNumberOrString } = require('../utils');

// Generic async sleep helper (used for Modbus pacing/backoff)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


function _errCode(err) {
  try { return (err && err.code) ? String(err.code) : ''; } catch (_) { return ''; }
}

function _errMsg(err) {
  try { return (err && err.message) ? String(err.message) : String(err); } catch (_) { return ''; }
}

function isTransportError(err) {
  const code = _errCode(err);
  const msg = _errMsg(err);
  const lower = msg.toLowerCase();

  if ([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'ERR_SOCKET_CLOSED',
    'E_MODBUS_OPERATION_TIMEOUT',
    'E_MODBUS_CONNECT_TIMEOUT',
    'E_MODBUS_BUSY_STALE',
  ].includes(code)) return true;

  // modbus-serial commonly uses this message when the underlying socket/serial port is closed
  if (lower.includes('port not open')) return true;

  // modbus-serial sometimes reports timeouts without setting an error code.
  // In that case we still want to treat it like a transport problem and force a reconnect.
  if (lower.includes('timed out') || lower.includes('timeout')) return true;
  if (lower.includes('hard-timeout') || lower.includes('hard timeout')) return true;

  // generic socket messages
  if (lower.includes('not connected')) return true;
  if (lower.includes('socket') && (lower.includes('hang up') || lower.includes('closed') || lower.includes('ended'))) return true;

  return false;
}


function isModbusIllegalAddressOrValue(err) {
  const msg = _errMsg(err).toLowerCase();
  const rawCode = (() => {
    try {
      return err && (err.modbusCode ?? err.exceptionCode ?? err.exception ?? err.modbusExceptionCode ?? err.responseCode);
    } catch (_) {
      return undefined;
    }
  })();
  const code = Number(rawCode);
  if (code === 2 || code === 3) return true;
  if (msg.includes('modbus exception 2') || msg.includes('exception 2:')) return true;
  if (msg.includes('modbus exception 3') || msg.includes('exception 3:')) return true;
  if (msg.includes('illegal data address') || msg.includes('illegal address')) return true;
  if (msg.includes('illegal data value') || msg.includes('illegal value')) return true;
  return false;
}

function normalizeAddressFallbackOffsets(src) {
  const raw = src && (src.fallbackAddressOffsets ?? src.alternateAddressOffsets ?? src.retryAddressOffsets ?? src.addressFallbackOffsets);
  const arr = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
  const out = [];
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n === 0) continue;
    // Conservative: this is for documented off-by-one vendor variants only, not arbitrary scanning.
    if (Math.abs(n) > 2) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}


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


function decodeBcdHhmmss(buf) {
  // Mennekes and a few other Modbus devices expose time-of-day as
  // big-endian packed BCD with left-zero padding across two registers.
  // Example bytes: 00 12 34 56 -> "12:34:56".
  if (!buf || !buf.length) return '';
  let digits = '';
  for (const b of buf) {
    const hi = (b >>> 4) & 0x0F;
    const lo = b & 0x0F;
    if (hi > 9 || lo > 9) return '';
    digits += String(hi) + String(lo);
  }
  if (digits.length < 6) digits = digits.padStart(6, '0');
  digits = digits.slice(-6);
  const hh = digits.slice(0, 2);
  const mm = digits.slice(2, 4);
  const ss = digits.slice(4, 6);
  return `${hh}:${mm}:${ss}`;
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

    case 'bcd_hhmmss':
    case 'bcdhhmmss':
    case 'hhmmss_bcd':
    case 'hhmmss':
      return decodeBcdHhmmss(buf);

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


function isNumericModbusDataType(dataType) {
  const t = (dataType || 'uint16').toString().toLowerCase();
  return !['string', 'ascii', 'bool', 'boolean', 'bcd_hhmmss', 'bcdhhmmss', 'hhmmss_bcd', 'hhmmss'].includes(t);
}

function dataTypeWordLength(dataType) {
  const t = (dataType || 'uint16').toString().toLowerCase();
  if (t === 'bool' || t === 'boolean' || t === 'int16' || t === 'uint16') return 1;
  if (t === 'int32' || t === 'uint32' || t === 'float32') return 2;
  if (t === 'int64' || t === 'uint64' || t === 'float64') return 4;
  return 1;
}

function parseNumericMaybeHex(x) {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string') {
    const s = x.trim().toLowerCase();
    if (!s) return undefined;
    if (s.startsWith('0x')) {
      const n = parseInt(s, 16);
      return Number.isFinite(n) ? n : undefined;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeAllowedValues(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    const n = parseNumericMaybeHex(v);
    if (n !== undefined && !out.includes(n)) out.push(n);
  }
  return out;
}

function applyWriteValueConstraints(raw, src, dpId) {
  const dt = (src && src.dataType ? src.dataType : 'uint16').toString().toLowerCase();
  if (src && src.valueMap && typeof src.valueMap === 'object') {
    const key = String(raw);
    if (Object.prototype.hasOwnProperty.call(src.valueMap, key)) {
      raw = src.valueMap[key];
    }
  }

  if (!isNumericModbusDataType(dt)) return raw;

  const n = parseNumericMaybeHex(raw);
  if (src && src.finite === true && n === undefined) {
    throw new Error(`Invalid non-numeric Modbus write value for ${dpId || 'datapoint'}: ${raw}`);
  }

  let v = (n !== undefined) ? n : raw;
  if (typeof v !== 'number') return v;
  if (!Number.isFinite(v)) {
    throw new Error(`Invalid non-finite Modbus write value for ${dpId || 'datapoint'}: ${raw}`);
  }

  const allowed = normalizeAllowedValues(src && (src.allowedValues || src.enumValues || src.validValues));
  if (allowed.length && !allowed.includes(v)) {
    throw new Error(`Invalid Modbus write value for ${dpId || 'datapoint'}: ${v}. Allowed values: ${allowed.join(', ')}`);
  }

  const min = parseNumericMaybeHex(src && (src.minValue ?? src.min ?? src.writeMin));
  const max = parseNumericMaybeHex(src && (src.maxValue ?? src.max ?? src.writeMax));
  if (min !== undefined && v < min) {
    throw new Error(`Invalid Modbus write value for ${dpId || 'datapoint'}: ${v} is below minimum ${min}`);
  }
  if (max !== undefined && v > max) {
    throw new Error(`Invalid Modbus write value for ${dpId || 'datapoint'}: ${v} is above maximum ${max}`);
  }

  if (src && (src.round === true || src.integer === true || src.int === true)) v = Math.round(v);
  return v;
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

function buildGroups(items, maxRegs, options) {
  const max = Number(maxRegs || 120);
  // Some devices reject requests that include unmapped/reserved registers even
  // when the requested span is small. For those templates, set
  // driverHints.modbus.strictContiguousReads=true to split reads at gaps.
  const allowGaps = !(options && options.allowGaps === false);
  // Some devices expose optional registers inside otherwise contiguous ranges. If one
  // optional register rejects the request, a combined group can suppress important
  // neighbours. isolateItems keeps each datapoint in its own Modbus request while
  // still reading multi-register values (FLOAT32/FLOAT64/STRING) atomically.
  const isolateItems = !!(options && options.isolateItems === true);

  const dps = (items || [])
    .map(item => {
      const addr = Number(item.addr);
      const len = Number(item.len || 1);
      return { ...item, addr, len, end: addr + len - 1 };
    })
    .sort((a, b) => a.addr - b.addr);

  if (isolateItems) {
    return dps.map(item => ({ start: item.addr, end: item.end, items: [item] }));
  }

  const groups = [];
  let g = null;

  for (const item of dps) {
    if (!g) {
      g = { start: item.addr, end: item.end, items: [item] };
      continue;
    }

    const newEnd = Math.max(g.end, item.end);
    const span = newEnd - g.start + 1;
    const contiguous = item.addr <= (g.end + 1);

    if (span <= max && (allowGaps || contiguous)) {
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
    this.asciiBus = null;
    this.asciiBusKey = null;

    if (deviceConfig.protocol === 'modbusTcp') {
      this.client = new ModbusRTU();
    }
    this.connected = false;
    this.connecting = false;
    this._busy = false;

    // Cache for dynamic scale factors (e.g. SunSpec *_SF registers)
    this._sfCache = new Map();
    this._sfWarnedUntil = new Map(); // throttle warnings for broken scale factors (e.g. wrong endian)

    const c = deviceConfig.connection || {};

    // Optional driver hints from templates (best-effort)
    const hints = (template && template.driverHints && template.driverHints.modbus) ? template.driverHints.modbus : {};
    this._modbusHints = hints;
    this._serialDefaults = (hints && typeof hints.serialDefaults === 'object' && hints.serialDefaults) ? hints.serialDefaults : null;
    this._asciiResponseStart = String((c.asciiResponseStart ?? hints.asciiResponseStart ?? (this._serialDefaults && this._serialDefaults.asciiResponseStart) ?? ':')).trim() || ':';

    // Optional SolaX VPP Mode-4 block write (new protocol requires multi-write
    // starting at 0x00A0 with a fixed length for the selected mode).
    // Configured via template.driverHints.modbus.solaxVppMode4.
    this._solaxVppMode4 = (hints && typeof hints.solaxVppMode4 === 'object') ? hints.solaxVppMode4 : null;

    // Optional SolaX VPP Mode-8 block write (PV & BAT individual setting - duration mode).
    // Configured via template.driverHints.modbus.solaxVppMode8.
    this._solaxVppMode8 = (hints && typeof hints.solaxVppMode8 === 'object') ? hints.solaxVppMode8 : null;

    // Optional FoxESS Remote Control block write (battery power target needs a multi-write starting at 46001).
    // Configured via template.driverHints.modbus.foxessRemoteControl.
    this._foxessRemoteControl = (hints && typeof hints.foxessRemoteControl === 'object') ? hints.foxessRemoteControl : null;

    // Optional Sungrow signed battery power control. Sungrow SH/Logger/iHM use separate
    // registers for mode, charge/discharge command and unsigned power. This helper exposes
    // a single signed W datapoint (+ discharge / - charge / 0 stop) while writing the required
    // companion registers automatically.
    // Configured via template.driverHints.modbus.sungrowSignedPowerControl(s).
    const sgPc = hints && (hints.sungrowSignedPowerControls || hints.sungrowSignedPowerControl || hints.sungrowPowerControl);
    this._sungrowSignedPowerControls = Array.isArray(sgPc) ? sgPc : (sgPc && typeof sgPc === 'object' ? [sgPc] : []);

    this.protocol = deviceConfig.protocol; // modbusTcp or modbusRtu
    // Treat 0 or invalid values as "use default" (the UI often uses 0 to mean "not set").
    const cfgTimeout = Number(c.timeoutMs);
    const hintTimeout = Number(hints.timeoutMs);
    const globalTimeout = Number(this.global.modbusTimeoutMs);

    if (Number.isFinite(cfgTimeout) && cfgTimeout > 0) {
      this.timeoutMs = cfgTimeout;
    } else if (Number.isFinite(hintTimeout) && hintTimeout > 0) {
      this.timeoutMs = hintTimeout;
    } else if (Number.isFinite(globalTimeout) && globalTimeout > 0) {
      this.timeoutMs = globalTimeout;
    } else {
      this.timeoutMs = 2000;
    }

    // Keep manual vs. auto-discovered values separate.
    // - manualUnitId / manualAddressOffset come from the device config
    // - autoUnitId / autoAddressOffset can be discovered at runtime (e.g. SunSpec base scan)
    const cfgUnitId = Number(c.unitId);
    const hintUnitId = Number(hints.unitIdDefault);
    const rawEnforceUnitIdDefault = (c.enforceUnitIdDefault ?? hints.enforceUnitIdDefault ?? false);
    const enforceUnitIdDefault = rawEnforceUnitIdDefault === true || String(rawEnforceUnitIdDefault).toLowerCase() === 'true';

    if (enforceUnitIdDefault && Number.isFinite(hintUnitId) && hintUnitId > 0) {
      // Some Modbus profiles use fixed server/unit addresses per register group.
      // For those templates, stale admin configs must not override the protocol value
      // (e.g. Alfen NG9xx: socket1=1, socket2=2, station/SCN=200).
      this.manualUnitId = hintUnitId;
    } else if (Number.isFinite(cfgUnitId) && cfgUnitId > 0) {
      this.manualUnitId = cfgUnitId;
    } else if (Number.isFinite(hintUnitId) && hintUnitId > 0) {
      this.manualUnitId = hintUnitId;
    } else {
      this.manualUnitId = 1;
    }
    this.autoUnitId = null;
    this.unitId = this.manualUnitId;
    this._tcpCurrentUnitId = null;

    const forcedAddressOffsetRaw = (c.forceAddressOffset ?? hints.forceAddressOffset ?? hints.enforcedAddressOffset);
    const forcedAddressOffset = Number(forcedAddressOffsetRaw);
    if (forcedAddressOffsetRaw !== undefined && forcedAddressOffsetRaw !== null && forcedAddressOffsetRaw !== '' && Number.isFinite(forcedAddressOffset)) {
      // Template/device enforced offset. Used when template addresses are already protocol addresses
      // and a stale manual/global offset would shift all registers to the wrong place.
      this.manualAddressOffset = forcedAddressOffset;
    } else {
      const hintAddressOffset = Number(hints.addressOffsetDefault ?? hints.defaultAddressOffset);
      if (Number.isFinite(Number(c.addressOffset))) {
        this.manualAddressOffset = Number(c.addressOffset);
      } else if (Number.isFinite(hintAddressOffset)) {
        this.manualAddressOffset = hintAddressOffset;
      } else {
        this.manualAddressOffset = Number(this.global.registerAddressOffset ?? 0);
      }
    }
    this.autoAddressOffset = 0;

    // Optional driver hints from templates (best-effort)
    // (hints already defined above)
    this._autoSunSpec = (hints.autoSunSpec === true) || (hints.sunspec === true);
    this._sunSpecTemplateBase = Number(hints.sunSpecTemplateBase ?? 40000);
    this._sunSpecScanBases = Array.isArray(hints.sunSpecScanBases) ? hints.sunSpecScanBases.map(Number) : null;
    this._sunSpecScanUnitIds = Array.isArray(hints.sunSpecScanUnitIds) ? hints.sunSpecScanUnitIds.map(Number) : null;
    this._sunSpecScanFcs = Array.isArray(hints.sunSpecScanFunctionCodes) ? hints.sunSpecScanFunctionCodes.map(Number) : null;
    this._sunSpecDiscovered = false;
    this._sunSpecFc = null; // FC used for SunSpec registers (3/4)
    this._sunSpecFoundBase = null; // discovered base register for 'SunS'
    this._sunSpecModelsById = new Map(); // modelId -> [{offset,len}]
    this._sunSpecModelsScanned = false;

    // Modbus pacing/backoff:
    // Some devices (especially via monitoring modules) require a minimum delay between two Modbus commands.
    // If we hammer the device with too many back-to-back reads/writes, it may stop responding (timeouts)
    // until the TCP session is reset.
    const rawMinCmdInterval = (c.minCommandIntervalMs ?? hints.minCommandIntervalMs ?? hints.minIntervalMs ?? this.global.modbusMinCommandIntervalMs ?? 0);
    this.minCommandIntervalMs = Number(rawMinCmdInterval);
    if (!Number.isFinite(this.minCommandIntervalMs) || this.minCommandIntervalMs < 0) this.minCommandIntervalMs = 0;

    const rawReconnectBackoff = (c.reconnectBackoffMs ?? hints.reconnectBackoffMs ?? this.global.modbusReconnectBackoffMs ?? 0);
    this.reconnectBackoffMs = Number(rawReconnectBackoff);
    if (!Number.isFinite(this.reconnectBackoffMs) || this.reconnectBackoffMs < 0) this.reconnectBackoffMs = 0;

    const rawMaxBackoff = (c.maxReconnectBackoffMs ?? hints.maxReconnectBackoffMs ?? this.global.modbusMaxReconnectBackoffMs ?? 30000);
    this.maxReconnectBackoffMs = Number(rawMaxBackoff);
    if (!Number.isFinite(this.maxReconnectBackoffMs) || this.maxReconnectBackoffMs < 0) this.maxReconnectBackoffMs = 30000;
    if (this.maxReconnectBackoffMs < this.reconnectBackoffMs) this.maxReconnectBackoffMs = this.reconnectBackoffMs;

    // Maximum Modbus register span per read request (best-effort).
    // Default is 120 (fits many devices). Some devices reject reads that cross unmapped registers.
    const rawMaxReadRegs = (c.maxReadRegs ?? hints.maxReadRegs ?? hints.maxReadRegisters ?? this.global.modbusMaxReadRegs ?? 120);
    this.maxReadRegs = Number(rawMaxReadRegs);
    if (!Number.isFinite(this.maxReadRegs) || this.maxReadRegs <= 0) this.maxReadRegs = 120;

    const rawStrictContiguousReads = (c.strictContiguousReads ?? c.strictReadGroups ?? hints.strictContiguousReads ?? hints.strictReadGroups ?? hints.noReadGaps ?? false);
    this.strictContiguousReads = rawStrictContiguousReads === true || String(rawStrictContiguousReads).toLowerCase() === 'true';

    const rawIsolateReadDatapoints = (c.isolateReadDatapoints ?? c.isolateModbusReadDatapoints ?? c.isolateReads ?? hints.isolateReadDatapoints ?? hints.isolateModbusReadDatapoints ?? hints.isolateReads ?? false);
    this.isolateReadDatapoints = rawIsolateReadDatapoints === true || String(rawIsolateReadDatapoints).toLowerCase() === 'true';

    // Optional best-effort reads for large vendor templates. Some Modbus devices abort
    // the TCP session when a request hits optional/reserved register ranges. With this
    // enabled, non-critical read groups are skipped temporarily after a failure while
    // required live values can continue to update.
    const rawContinueOnReadError = (c.continueOnReadError ?? c.ignoreOptionalReadErrors ?? hints.continueOnReadError ?? hints.ignoreOptionalReadErrors ?? false);
    this.continueOnReadError = rawContinueOnReadError === true || String(rawContinueOnReadError).toLowerCase() === 'true';

    const requiredReadDpIdsRaw = (c.requiredReadDpIds ?? hints.requiredReadDpIds ?? hints.requiredDpIds ?? []);
    const requiredReadDpIds = Array.isArray(requiredReadDpIdsRaw) ? requiredReadDpIdsRaw : [];
    this.requiredReadDpIds = new Set(requiredReadDpIds.map(x => String(x)).filter(Boolean));

    const rawSkipFailedReadGroupsMs = (c.skipFailedReadGroupsMs ?? hints.skipFailedReadGroupsMs ?? 300000);
    this.skipFailedReadGroupsMs = Number(rawSkipFailedReadGroupsMs);
    if (!Number.isFinite(this.skipFailedReadGroupsMs) || this.skipFailedReadGroupsMs < 0) this.skipFailedReadGroupsMs = 300000;

    this._readGroupSkipUntil = new Map();
    this._readGroupWarnUntil = new Map();


    this._lastCommandAt = 0;
    this._ioQueue = Promise.resolve();
    this._failStreak = 0;
    this._nextConnectAt = 0;
    this._connectWaitWarnAt = 0;
    this._busySince = 0;

    // Independent hard timeouts around Modbus operations. This protects the adapter from
    // rare cases where the underlying library/socket never resolves after a device-side
    // timeout. Without this guard the per-device IO queue can remain pending forever and
    // the adapter will not recover until restart.
    const rawOperationTimeout = (c.operationTimeoutMs ?? c.hardTimeoutMs ?? hints.operationTimeoutMs ?? hints.hardTimeoutMs ?? this.global.modbusOperationTimeoutMs);
    const opDefault = Math.max(Number(this.timeoutMs || 0) * 2, Number(this.timeoutMs || 0) + 1500, 5000);
    this.operationTimeoutMs = Number(rawOperationTimeout);
    if (!Number.isFinite(this.operationTimeoutMs) || this.operationTimeoutMs <= 0) this.operationTimeoutMs = opDefault;
    this.operationTimeoutMs = Math.max(this.operationTimeoutMs, Number(this.timeoutMs || 0) + 250);

    const rawConnectTimeout = (c.connectTimeoutMs ?? hints.connectTimeoutMs ?? this.global.modbusConnectTimeoutMs);
    this.connectTimeoutMs = Number(rawConnectTimeout);
    if (!Number.isFinite(this.connectTimeoutMs) || this.connectTimeoutMs <= 0) this.connectTimeoutMs = Math.max(this.operationTimeoutMs, Number(this.timeoutMs || 0) + 1500, 5000);

    // Optional pre-write unlock sequence (device-specific; configured via template driverHints)
    this._writeUnlock = null;
    this._writeUnlockUntil = 0;

    // Allow per-device override via connection settings
    if (typeof c.autoSunSpec === 'boolean') this._autoSunSpec = c.autoSunSpec;
    if (Number.isFinite(Number(c.sunSpecTemplateBase))) this._sunSpecTemplateBase = Number(c.sunSpecTemplateBase);

    // Template-defined write-unlock sequence (e.g. SolaX requires UnlockPassword before VPP writes)
    // Structure example in templates.json:
    // driverHints.modbus.writeUnlock = {
    //   fc: 6,
    //   address: 0,
    //   dataType: 'uint16',
    //   length: 1,
    //   passwordField: 'writePassword',
    //   defaultPassword: 2014,
    //   cacheMs: 5000
    // }
    const wh = (hints && (hints.writeUnlock || hints.unlock)) ? (hints.writeUnlock || hints.unlock) : null;
    if (wh && typeof wh === 'object') {
      const addr = Number(wh.address);
      if (Number.isFinite(addr)) {
        this._writeUnlock = {
          fc: Number(wh.fc ?? 6),
          address: addr,
          length: Number(wh.length ?? 1),
          dataType: (wh.dataType || 'uint16').toString(),
          passwordField: (wh.passwordField || 'writePassword').toString(),
          defaultPassword: (wh.defaultPassword ?? wh.password ?? null),
          cacheMs: Number(wh.cacheMs ?? 0),
        };
      }
    } else if (hints && hints.unlockPassword === true) {
      // Backwards-compatible shorthand: enable default unlock register @0 (FC6 uint16)
      this._writeUnlock = { fc: 6, address: 0, length: 1, dataType: 'uint16', passwordField: 'writePassword', defaultPassword: null, cacheMs: 0 };
    }

    this.wordOrder = normalizeWordOrder(c.wordOrder || 'be');
    this.byteOrder = normalizeByteOrder(c.byteOrder || 'be');
  }


  _isTcpOpen() {
    if (this.protocol !== 'modbusTcp') return true;
    const c = this.client;
    if (!c) return false;

    try {
      if (typeof c.isOpen === 'boolean') return c.isOpen;
      if (typeof c.isOpen === 'function') return !!c.isOpen();
    } catch (_) {
      // ignore
    }

    // modbus-serial internal port wrappers
    try {
      const p = c._port;
      // If modbus-serial detached its underlying TCP socket/port wrapper, treat as closed.
      // This prevents errors like: "Cannot read properties of null (reading 'writeRegister')".
      if (p === null) return false;
      if (p) {
        if (typeof p.isOpen === 'boolean') return p.isOpen;
        if (typeof p.isOpen === 'function') return !!p.isOpen();
        if (typeof p.destroyed === 'boolean') return !p.destroyed;
        if (p._client && typeof p._client.destroyed === 'boolean') return !p._client.destroyed;
        if (p._socket && typeof p._socket.destroyed === 'boolean') return !p._socket.destroyed;
        if (p.socket && typeof p.socket.destroyed === 'boolean') return !p.socket.destroyed;
      }
    } catch (_) {
      // ignore
    }

    // If we cannot determine, assume open and let real operations fail
    return true;
  }


  _makeTimeoutError(label, timeoutMs, code) {
    const ms = Number(timeoutMs || 0);
    const err = new Error(`${label || 'Modbus operation'} hard-timeout after ${ms} ms`);
    err.code = code || 'E_MODBUS_OPERATION_TIMEOUT';
    return err;
  }

  _forceCloseTcpClient(client) {
    if (!client) return;

    // modbus-serial close() is best-effort. On half-open TCP sessions we also try to
    // destroy the underlying socket so pending read/write callbacks are released.
    try { client.close(() => {}); } catch (_) {}

    try {
      const p = client._port;
      const candidates = [];
      if (p) {
        candidates.push(p);
        if (p._client) candidates.push(p._client);
        if (p._socket) candidates.push(p._socket);
        if (p.socket) candidates.push(p.socket);
        if (p.client) candidates.push(p.client);
      }
      for (const sock of candidates) {
        if (!sock) continue;
        try { if (typeof sock.setKeepAlive === 'function') sock.setKeepAlive(false); } catch (_) {}
        try { if (typeof sock.end === 'function') sock.end(); } catch (_) {}
        try { if (typeof sock.destroy === 'function') sock.destroy(); } catch (_) {}
      }
    } catch (_) {}
  }

  async _withHardTimeout(promise, timeoutMs, label, onTimeout) {
    const ms = Number(timeoutMs || 0);
    if (!Number.isFinite(ms) || ms <= 0) return await promise;

    let timer = null;
    let timedOut = false;

    const op = Promise.resolve(promise).catch((err) => {
      // If the operation rejects after our hard timeout already fired, suppress the
      // late rejection. The caller has already moved on with a clean reconnect.
      if (timedOut) {
        try {
          this.adapter.log.debug(`[${this.device?.id || 'modbus'}] Late Modbus operation rejection after timeout ignored: ${err && err.message ? err.message : err}`);
        } catch (_) {}
        return new Promise(() => {});
      }
      throw err;
    });

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const err = this._makeTimeoutError(label, ms, label && String(label).toLowerCase().includes('connect') ? 'E_MODBUS_CONNECT_TIMEOUT' : 'E_MODBUS_OPERATION_TIMEOUT');
        try { if (typeof onTimeout === 'function') onTimeout(err); } catch (_) {}
        reject(err);
      }, ms);
      try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (_) {}
    });

    try {
      return await Promise.race([op, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _markDisconnected(err) {
    this.connected = false;
    this.connecting = false;

    // Backoff on repeated transport errors. Some devices will stop responding if polled too hard.
    // A short cooldown prevents rapid reconnect loops and gives the device time to recover.
    try {
      const now = Date.now();
      const base = Math.max(Number(this.reconnectBackoffMs || 0), Number(this.minCommandIntervalMs || 0), 0);
      if (base > 0) {
        this._failStreak = Math.min((this._failStreak || 0) + 1, 10);
        const max = Number(this.maxReconnectBackoffMs || 30000);
        const delay = Math.min(base * Math.pow(2, this._failStreak - 1), max);
        this._nextConnectAt = now + delay;
      }
    } catch (_) {
      // ignore
    }

    if (this.protocol === 'modbusTcp') {
      const oldClient = this.client;
      if (oldClient) this._forceCloseTcpClient(oldClient);
      // Force a clean client for the next connect attempt (avoids stale sockets after ECONNRESET/timeouts)
      if (this.client === oldClient) this.client = null;
    }

    // Break a possibly poisoned IO queue after transport loss. This is safe because the
    // stale client/socket has just been closed; new operations will reconnect first.
    try { this._ioQueue = Promise.resolve(); } catch (_) {}
  }


  _getSerialOption(key, fallback) {
    const c = this.device?.connection || {};
    const defs = this._serialDefaults || null;
    const enforce = !!(defs && defs.enforce);
    if (enforce && defs && defs[key] !== undefined) return defs[key];
    const raw = c[key];
    if (raw !== undefined && raw !== null && raw !== '') return raw;
    if (defs && defs[key] !== undefined) return defs[key];
    return fallback;
  }

  _getSerialConnOpts() {
    return {
      path: (this._getSerialOption('path', this.device?.connection?.path || '') || '').toString().trim(),
      baudRate: Number(this._getSerialOption('baudRate', 9600)),
      parity: (this._getSerialOption('parity', 'none') || 'none').toString(),
      dataBits: Number(this._getSerialOption('dataBits', 8)),
      stopBits: Number(this._getSerialOption('stopBits', 1)),
      responseStart: (String(this._asciiResponseStart || ':').trim() || ':').charAt(0),
    };
  }

  async connect() {
    if (this.connected) return;

    // If another caller is already connecting, wait for it instead of returning early.
    // Returning early while connected=false lets the next read continue against a not-yet-open
    // TCP client and can permanently poison the queue on slow devices.
    if (this.connecting) {
      const started = Date.now();
      const maxWait = Math.max(Number(this.connectTimeoutMs || 0), Number(this.operationTimeoutMs || 0), 5000);
      while (this.connecting && !this.connected && (Date.now() - started) < maxWait) {
        await sleep(50);
      }
      if (this.connected) return;
      if (this.connecting) {
        const err = this._makeTimeoutError('Modbus TCP connect wait', maxWait, 'E_MODBUS_CONNECT_TIMEOUT');
        this._markDisconnected(err);
        throw err;
      }
    }

    this.connecting = true;

    // Respect reconnect backoff (prevents hammering devices that temporarily stop responding)
    try {
      const now = Date.now();
      if (this._nextConnectAt && now < this._nextConnectAt) {
        await sleep(this._nextConnectAt - now);
      }
    } catch (_) {
      // ignore
    }

    const c = this.device.connection || {};
    try {
      if (this.protocol === 'modbusTcp') {
        const host = c.host;
        const port = Number(c.port || 502);

        // Always start with a clean client. Some devices/field networks close idle sockets;
        // modbus-serial may keep stale socket handles after ECONNRESET/timeout.
        try {
          if (this.client) this._forceCloseTcpClient(this.client);
        } catch (_) {}

        const tcpClient = new ModbusRTU();
        this.client = tcpClient;

        const connectPromise = new Promise((resolve, reject) => {
          tcpClient.connectTCP(host, { port }, (err) => err ? reject(err) : resolve());
        });

        await this._withHardTimeout(
          connectPromise,
          this.connectTimeoutMs,
          `Modbus TCP connect ${host || ''}:${port}`,
          () => {
            this._forceCloseTcpClient(tcpClient);
            if (this.client === tcpClient) this.client = null;
          }
        );

        // The connection may have completed after a timeout and been replaced/closed.
        if (this.client !== tcpClient) {
          const err = new Error('Modbus TCP connect completed on stale client');
          err.code = 'ERR_SOCKET_CLOSED';
          throw err;
        }

        // Best-effort: enable TCP keepalive on the underlying socket if accessible
        try {
          const p = this.client && this.client._port ? this.client._port : null;
          const sock = p && (p._client || p._socket || p.socket || p);
          if (sock && typeof sock.setKeepAlive === 'function') sock.setKeepAlive(true, 10000);
        } catch (_) {}

        this.client.setID(this.unitId);
        this._tcpCurrentUnitId = this.unitId;
        this.client.setTimeout(this.timeoutMs);
      } else if (this.protocol === 'modbusRtu') {
        const serial = this._getSerialConnOpts();
        if (!this.rtuBus) {
          const { key, bus } = acquireBus(this.adapter, {
            path: serial.path,
            baudRate: serial.baudRate,
            parity: serial.parity,
            dataBits: serial.dataBits,
            stopBits: serial.stopBits,
          });
          this.rtuBusKey = key;
          this.rtuBus = bus;
        }
        await this.rtuBus.ensureConnected();
      } else if (this.protocol === 'modbusAscii') {
        const serial = this._getSerialConnOpts();
        if (!this.asciiBus) {
          const { key, bus } = acquireAsciiBus(this.adapter, {
            path: serial.path,
            baudRate: serial.baudRate,
            parity: serial.parity,
            dataBits: serial.dataBits,
            stopBits: serial.stopBits,
            responseStart: serial.responseStart,
          });
          this.asciiBusKey = key;
          this.asciiBus = bus;
        }
        await this.asciiBus.ensureConnected();
      } else {
        throw new Error(`Unsupported Modbus protocol: ${this.protocol}`);
      }

      this.connected = true;
      this._failStreak = 0;
      this._nextConnectAt = 0;
      this.adapter.log.info(`[${this.device.id}] Modbus connected (${this.protocol})`);

      // Optional SunSpec base / unit-id discovery (only when enabled via template hints).
      try {
        await this._maybeDiscoverSunSpec();
      } catch (e) {
        // Discovery must never break connectivity.
        this.adapter.log.debug(`[${this.device.id}] SunSpec discovery error: ${e && e.message ? e.message : e}`);
      }
    } catch (e) {
      // Ensure we always reset the internal state and apply backoff on connect failures
      if (isTransportError(e)) {
        this._markDisconnected(e);
      } else {
        // still close any stale socket to avoid half-open sessions
        this._markDisconnected(e);
      }
      throw e;
    } finally {
      this.connecting = false;
    }
  }

  async disconnect() {
    try {
      if (this.protocol === 'modbusTcp') {
        if (this.client) {
          this._forceCloseTcpClient(this.client);
          this.client = null;
        }
      } else if (this.protocol === 'modbusRtu') {
        if (this.rtuBusKey) {
          releaseBus(this.rtuBusKey);
        }
        this.rtuBus = null;
        this.rtuBusKey = null;
      } else if (this.protocol === 'modbusAscii') {
        if (this.asciiBusKey) {
          releaseAsciiBus(this.asciiBusKey);
        }
        this.asciiBus = null;
        this.asciiBusKey = null;
      }
    } finally {
      this.connected = false;
      this.connecting = false;
      this._tcpCurrentUnitId = null;
    }
  }

  async ensureConnected() {
    if (this.connected) {
      if (this.protocol === 'modbusTcp' && !this._isTcpOpen()) {
        this._markDisconnected(new Error('Port Not Open'));
      } else {
        return true;
      }
    }
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
      try { this.client.setID(uid); this._tcpCurrentUnitId = uid; } catch (_) {}
    }
  }

  _operationUnitId(unitIdOverride) {
    const n = Number(unitIdOverride);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    const base = Number(this.unitId);
    return (Number.isFinite(base) && base > 0) ? Math.trunc(base) : 1;
  }

  _sourceUnitId(src) {
    if (!src) return this._operationUnitId();
    const raw = (src.unitId ?? src.slaveId ?? src.serverAddress ?? src.deviceId ?? src.modbusUnitId);
    return this._operationUnitId(raw);
  }

  _setTcpRequestUnitId(uid) {
    const id = this._operationUnitId(uid);
    if (this.protocol !== 'modbusTcp' || !this.client || typeof this.client.setID !== 'function') return id;
    // modbus-serial keeps the Unit-ID/Slave-ID as mutable state on the TCP client.
    // Set it directly before every operation so templates can safely address vendors
    // such as Alfen where one IP exposes different register groups through different Unit-IDs.
    try {
      if (this._tcpCurrentUnitId !== id) {
        this.client.setID(id);
        this._tcpCurrentUnitId = id;
      }
    } catch (_) {}
    return id;
  }

  _addr(src) {
    let a = Number(src?.address || 0);

    // Optional per-datapoint address base offset via device settings.
    // Useful for devices that expose multiple blocks (e.g. different coil blocks, configurable start address).
    // Example in template source:
    //   { address: 0, addressOffsetSetting: 'coilReadOffset' }
    let extra = 0;
    const key = src?.addressOffsetSetting;
    if (key) {
      const k = String(key);
      const raw = (this.device && (this.device[k] ?? this.device?.settings?.[k]));
      const n = Number(raw);
      if (Number.isFinite(n)) extra += n;
    }

    // SunSpec dynamic address resolution:
    // If a datapoint source specifies a SunSpec model + offset, we resolve the absolute register
    // address using the scanned SunSpec model map (modelId -> start offset).
    //
    // Example source:
    //   { kind:'modbus', fc:3, sunspecModel:103, sunspecOffset:14, length:1, dataType:'int16' }
    if (src && src.sunspecModel !== undefined && src.sunspecModel !== null) {
      const modelId = Number(src.sunspecModel);
      const modelIndex = Number(src.sunspecIndex ?? src.sunspecInstance ?? 0);
      const pointOff = Number(src.sunspecOffset ?? 0);
      const templateBase = Number(this._sunSpecTemplateBase ?? 40000);

      if (Number.isFinite(modelId) && Number.isFinite(pointOff) && Number.isFinite(templateBase)) {
        try {
          const arr = this._sunSpecModelsById ? this._sunSpecModelsById.get(modelId) : null;
          const idx = Number.isFinite(modelIndex) ? Math.max(0, Math.trunc(modelIndex)) : 0;
          const entry = (arr && arr.length) ? arr[idx] : null;

          if (entry && Number.isFinite(Number(entry.offset))) {
            a = templateBase + Number(entry.offset) + pointOff;
          } else if (a === 0) {
            // Model is not present on this device -> skip this datapoint.
            a = NaN;
          }
        } catch (_) {
          // ignore and fall back to 'address'
        }
      }
    }

    return a + this.manualAddressOffset + this.autoAddressOffset + extra;
  }

  async _getDpStateNumber(dpId) {
    if (!dpId) return undefined;
    try {
      const fullId = `${this.adapter.namespace}.devices.${this.device.id}.${String(dpId)}`;
      const st = await this.adapter.getStateAsync(fullId);
      if (!st || st.val === null || st.val === undefined) return undefined;
      const n = Number(st.val);
      return Number.isFinite(n) ? n : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async _waitForMinCommandInterval() {
    const min = Number(this.minCommandIntervalMs || 0);
    if (!min || min <= 0) return;

    const last = Number(this._lastCommandAt || 0);
    if (!last || last <= 0) return;

    const now = Date.now();
    const next = last + min;
    if (now < next) {
      await sleep(next - now);
    }
  }

  async _withIoLock(fn, label = 'Modbus operation') {
    // Serialize all Modbus operations per device. This avoids read/write interleaving
    // and also allows us to enforce a minimum interval between commands.
    const run = async () => {
      await this._waitForMinCommandInterval();
      this._lastCommandAt = Date.now();
      try {
        const res = await this._withHardTimeout(
          Promise.resolve().then(fn),
          this.operationTimeoutMs,
          label,
          (err) => {
            if (isTransportError(err)) this._markDisconnected(err);
          }
        );
        // On any successful Modbus operation we reset the failure streak/backoff
        this._failStreak = 0;
        this._nextConnectAt = 0;
        return res;
      } catch (e) {
        if (isTransportError(e)) this._markDisconnected(e);
        throw e;
      }
    };

    const p = (this._ioQueue || Promise.resolve())
      .catch(() => {})
      .then(run);

    // Keep the queue alive even if the current op fails. The hard-timeout above ensures
    // that a lost Modbus callback cannot keep this queue pending forever.
    this._ioQueue = p.catch(() => {});
    return p;
  }

  _getWritePassword() {
    if (!this._writeUnlock) return null;
    const field = (this._writeUnlock.passwordField || 'writePassword').toString();
    const c = this.device?.connection || {};
    const v = c[field];
    if (v !== null && v !== undefined) {
      const s = String(v).trim();
      if (s) return s;
    }

    // Template-level default (device specific). This enables "it just works" write control
    // for devices that have a fixed default unlock password (e.g. many SolaX models).
    const def = this._writeUnlock.defaultPassword;
    if (def === null || def === undefined) return null;
    const ds = String(def).trim();
    return ds ? ds : null;
  }

  async _maybeUnlockForWrite(currentWriteSrc) {
    if (!this._writeUnlock) return;

    const pwStr = this._getWritePassword();
    if (!pwStr) return;

    // Avoid accidental recursion: if the datapoint we are writing *is* the unlock register itself.
    try {
      if (currentWriteSrc) {
        const cfc = Number(currentWriteSrc.fc);
        const caddr = Number(currentWriteSrc.address);
        if (cfc === Number(this._writeUnlock.fc) && caddr === Number(this._writeUnlock.address)) return;
      }
    } catch (e) {
      // ignore
    }

    const now = Date.now();
    const cacheMs = Number(this._writeUnlock.cacheMs || 0);
    if (cacheMs > 0 && this._writeUnlockUntil && now < this._writeUnlockUntil) return;

    let pw = parseInt(pwStr, 10);
    if (!Number.isFinite(pw)) pw = 0;
    if (pw < 0) pw = 0;

    const fc = Number(this._writeUnlock.fc || 6);
    const addr = Number(this._writeUnlock.address || 0) + this.manualAddressOffset + this.autoAddressOffset;

    // Only FC6 and FC16 make sense for unlocking.
    if (fc === 6) {
      await this._mbWriteRegister(addr, pw & 0xFFFF);
    } else if (fc === 16) {
      await this._mbWriteRegisters(addr, [pw & 0xFFFF]);
    } else {
      // Unsupported unlock FC -> ignore (but log)
      this.adapter.log.warn(`[${this.device.id}] writeUnlock configured with unsupported FC=${fc}. Skipping unlock.`);
      return;
    }

    if (cacheMs > 0) this._writeUnlockUntil = now + cacheMs;
    this.adapter.log.debug(`[${this.device.id}] Modbus write-unlock OK (FC${fc}@${addr}).`);
  }

  _sunSpecSignatureInfo(regs) {
    if (!Array.isArray(regs) || regs.length < 2) return null;
    const r0 = Number(regs[0]) & 0xFFFF;
    const r1 = Number(regs[1]) & 0xFFFF;

    // "SunS" in two 16-bit registers.
    // Normal (big-endian words, big-endian bytes): 0x5375 0x6E53
    if (r0 === 0x5375 && r1 === 0x6E53) return { wordOrder: 'be', byteOrder: 'be' };

    // Some devices swap bytes inside the 16-bit words: 0x7553 0x536E
    if (r0 === 0x7553 && r1 === 0x536E) return { wordOrder: 'be', byteOrder: 'le' };

    // Rare: swapped word order (should not happen for SunSpec, but we accept it for robustness)
    if (r0 === 0x6E53 && r1 === 0x5375) return { wordOrder: 'le', byteOrder: 'be' };
    if (r0 === 0x536E && r1 === 0x7553) return { wordOrder: 'le', byteOrder: 'le' };

    return null;
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

              const sig = this._sunSpecSignatureInfo(regs);
              if (sig) {
                // Compute only the *additional* offset beyond the manual offset.
                const autoOff = b - templateBase - this.manualAddressOffset;
                this.autoAddressOffset = autoOff;
                this.autoUnitId = uid;
                this._sunSpecFc = fc;
                this._sunSpecFoundBase = b;
                // Reset model scan cache because base/unit may have changed
                this._sunSpecModelsScanned = false;
                this._sunSpecModelsById = new Map();

                // SunSpec endian handling:
                // The SunSpec signature tells us whether bytes/words are swapped on this device.
                // We enforce the detected endian regardless of the user/device connection settings
                // because wrong byte/word order will completely break SF scaling (e.g. values like 2.4e+260).
                const prevWo = this.wordOrder;
                const prevBo = this.byteOrder;
                if (sig && sig.wordOrder) this.wordOrder = sig.wordOrder;
                if (sig && sig.byteOrder) this.byteOrder = sig.byteOrder;

                const endianNote = (prevWo !== this.wordOrder || prevBo !== this.byteOrder)
                  ? ` Endian: wordOrder=${this.wordOrder}, byteOrder=${this.byteOrder} (was wordOrder=${prevWo}, byteOrder=${prevBo}).`
                  : ` Endian: wordOrder=${this.wordOrder}, byteOrder=${this.byteOrder}.`;

                this.adapter.log.info(
                  `[${this.device.id}] SunSpec discovery: found 'SunS' at base=${b} (FC${fc}, unitId=${uid}). ` +
                  `Applying autoAddressOffset=${autoOff} (manualAddressOffset=${this.manualAddressOffset}).${endianNote}`
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



  async _maybeScanSunSpecModels() {
    if (!this._autoSunSpec) return false;
    if (this._sunSpecModelsScanned) return true;

    // Ensure discovery has run so we know the correct unitId/base/fc/endian.
    try {
      await this._maybeDiscoverSunSpec();
    } catch (_) {
      // ignore
    }

    const fc = (this._sunSpecFc === 4) ? 4 : 3;
    const templateBase = Number(this._sunSpecTemplateBase ?? 40000);
    const base = templateBase + this.manualAddressOffset + this.autoAddressOffset;

    if (!Number.isFinite(base) || base < 0 || base > 65535) return false;

    const readRegs = async (addr, len) => {
      if (fc === 4) return (await this._mbReadInputRegisters(addr, len)).data || [];
      return (await this._mbReadHoldingRegisters(addr, len)).data || [];
    };

    const modelsById = new Map();

    // Model blocks start right after the 2-register "SunS" signature.
    // Each model is:
    //   ID (uint16), L (uint16), <L registers payload>
    // End of map is ID=0xFFFF, L=0.
    let off = 2;
    const maxModels = 200;
    const maxOff = 20000;

    for (let i = 0; i < maxModels && off < maxOff; i++) {
      let hdr;
      try {
        hdr = await readRegs(base + off, 2);
      } catch (e) {
        break;
      }

      if (!Array.isArray(hdr) || hdr.length < 2) break;
      const did = Number(hdr[0]) & 0xFFFF;
      const len = Number(hdr[1]) & 0xFFFF;

      if (did === 0xFFFF) break;
      if (did === 0) break;

      if (!modelsById.has(did)) modelsById.set(did, []);
      modelsById.get(did).push({ offset: off, len });

      // Advance to next model header
      off += 2 + len;
    }

    this._sunSpecModelsById = modelsById;
    this._sunSpecModelsScanned = true;

    try {
      const ids = Array.from(modelsById.keys()).sort((a, b) => a - b);
      this.adapter.log.debug(`[${this.device.id}] SunSpec model scan OK (${ids.length}): ${ids.join(', ')}`);
    } catch (_) {}

    return true;
  }

  async _mbReadCoils(start, len, unitIdOverride = null) {
    return await this._withIoLock(async () => {
      const uid = this._operationUnitId(unitIdOverride);
      if (this.protocol === 'modbusRtu') return await this.rtuBus.readCoils(uid, this.timeoutMs, start, len);
      if (this.protocol === 'modbusAscii') return await this.asciiBus.readCoils(uid, this.timeoutMs, start, len);
      if (!this.client) {
        const err = new Error('Port Not Open');
        err.code = 'ERR_SOCKET_CLOSED';
        throw err;
      }
      this._setTcpRequestUnitId(uid);
      return await this.client.readCoils(start, len);
    });
  }

  async _mbReadDiscreteInputs(start, len, unitIdOverride = null) {
    return await this._withIoLock(async () => {
      const uid = this._operationUnitId(unitIdOverride);
      if (this.protocol === 'modbusRtu') return await this.rtuBus.readDiscreteInputs(uid, this.timeoutMs, start, len);
      if (this.protocol === 'modbusAscii') return await this.asciiBus.readDiscreteInputs(uid, this.timeoutMs, start, len);
      if (!this.client) {
        const err = new Error('Port Not Open');
        err.code = 'ERR_SOCKET_CLOSED';
        throw err;
      }
      this._setTcpRequestUnitId(uid);
      return await this.client.readDiscreteInputs(start, len);
    });
  }

  async _mbReadHoldingRegisters(start, len, unitIdOverride = null) {
    return await this._withIoLock(async () => {
      const uid = this._operationUnitId(unitIdOverride);
      if (this.protocol === 'modbusRtu') return await this.rtuBus.readHoldingRegisters(uid, this.timeoutMs, start, len);
      if (this.protocol === 'modbusAscii') return await this.asciiBus.readHoldingRegisters(uid, this.timeoutMs, start, len);
      if (!this.client) {
        const err = new Error('Port Not Open');
        err.code = 'ERR_SOCKET_CLOSED';
        throw err;
      }
      this._setTcpRequestUnitId(uid);
      return await this.client.readHoldingRegisters(start, len);
    });
  }

  async _mbReadInputRegisters(start, len, unitIdOverride = null) {
    return await this._withIoLock(async () => {
      const uid = this._operationUnitId(unitIdOverride);
      if (this.protocol === 'modbusRtu') return await this.rtuBus.readInputRegisters(uid, this.timeoutMs, start, len);
      if (this.protocol === 'modbusAscii') return await this.asciiBus.readInputRegisters(uid, this.timeoutMs, start, len);
      if (!this.client) {
        const err = new Error('Port Not Open');
        err.code = 'ERR_SOCKET_CLOSED';
        throw err;
      }
      this._setTcpRequestUnitId(uid);
      return await this.client.readInputRegisters(start, len);
    });
  }

  async _mbWriteCoil(addr, value, unitIdOverride = null) {
    return await this._withIoLock(async () => {
      const uid = this._operationUnitId(unitIdOverride);
      if (this.protocol === 'modbusRtu') return await this.rtuBus.writeCoil(uid, this.timeoutMs, addr, value);
      if (this.protocol === 'modbusAscii') return await this.asciiBus.writeCoil(uid, this.timeoutMs, addr, value);
      if (!this.client) {
        const err = new Error('Port Not Open');
        err.code = 'ERR_SOCKET_CLOSED';
        throw err;
      }
      this._setTcpRequestUnitId(uid);
      return await this.client.writeCoil(addr, value);
    });
  }

  async _mbWriteCoils(addr, values, unitIdOverride = null) {
    return await this._withIoLock(async () => {
      const uid = this._operationUnitId(unitIdOverride);
      if (this.protocol === 'modbusRtu') return await this.rtuBus.writeCoils(uid, this.timeoutMs, addr, values);
      if (this.protocol === 'modbusAscii') return await this.asciiBus.writeCoils(uid, this.timeoutMs, addr, values);
      if (!this.client) {
        const err = new Error('Port Not Open');
        err.code = 'ERR_SOCKET_CLOSED';
        throw err;
      }
      this._setTcpRequestUnitId(uid);
      return await this.client.writeCoils(addr, values);
    });
  }

  async _mbWriteRegister(addr, value, unitIdOverride = null) {
    return await this._withIoLock(async () => {
      const uid = this._operationUnitId(unitIdOverride);
      if (this.protocol === 'modbusRtu') return await this.rtuBus.writeRegister(uid, this.timeoutMs, addr, value);
      if (this.protocol === 'modbusAscii') return await this.asciiBus.writeRegister(uid, this.timeoutMs, addr, value);
      if (!this.client) {
        const err = new Error('Port Not Open');
        err.code = 'ERR_SOCKET_CLOSED';
        throw err;
      }
      this._setTcpRequestUnitId(uid);
      return await this.client.writeRegister(addr, value);
    });
  }

  async _mbWriteRegisters(addr, values, unitIdOverride = null) {
    return await this._withIoLock(async () => {
      const uid = this._operationUnitId(unitIdOverride);
      if (this.protocol === 'modbusRtu') return await this.rtuBus.writeRegisters(uid, this.timeoutMs, addr, values);
      if (this.protocol === 'modbusAscii') return await this.asciiBus.writeRegisters(uid, this.timeoutMs, addr, values);
      if (!this.client) {
        const err = new Error('Port Not Open');
        err.code = 'ERR_SOCKET_CLOSED';
        throw err;
      }
      this._setTcpRequestUnitId(uid);
      return await this.client.writeRegisters(addr, values);
    });
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
    if (!Number.isNaN(n) && n !== -32768) {
      // Sanity guard: scale factors are small exponents. Huge values are almost always
      // a byte/word-order or address-offset issue and will explode numbers (e.g. 2.4e+260).
      if (Math.abs(n) > 20) {
        const now = Date.now();
        const until = this._sfWarnedUntil ? (Number(this._sfWarnedUntil.get(key)) || 0) : 0;
        if (!until || now > until) {
          try {
            if (this._sfWarnedUntil) this._sfWarnedUntil.set(key, now + 60000); // 60s throttle per SF key
          } catch (_) {}
          this.adapter.log.warn(
            `[${this.device.id}] Suspicious scale factor ${key}=${n}. Ignoring scaling (SF=0). ` +
            `Check Modbus Byte-/Wortreihenfolge and address offset.`
          );
        }
        return 0;
      }
      return n;
    }
  }

  const n = Number(src.scaleFactor || 0);
  return Number.isNaN(n) ? 0 : n;
}

  _applyTransforms(value, src) {
    if (typeof value !== 'number') return value;
    if (Number.isNaN(value)) {
      // Optionally map IEEE NaN to null as well (useful for meters that export NaN for
      // non-supported values). Enabled per datapoint via `nanToNull`.
      if (src && (src.nanToNull === true || src.nanNull === true || src.nanToUndefined === true)) return null;
      return value;
    }

    let v = value;

    const parseIntMaybeHex = (x) => {
      if (x === null || x === undefined) return undefined;
      if (typeof x === 'number' && Number.isFinite(x)) return x;
      if (typeof x === 'string') {
        const s = x.trim().toLowerCase();
        if (s === '') return undefined;
        if (s.startsWith('0x')) {
          const n = parseInt(s, 16);
          return Number.isFinite(n) ? n : undefined;
        }
        const n = Number(s);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };

    // Optional explicit boolean value mapping. Many vendors use non-0/1 codes
    // for switches (e.g. Sungrow 0xAA=enable, 0x55=disable).
    const trueValue = parseIntMaybeHex(src && (src.trueValue ?? src.onValue ?? src.enableValue ?? src.valueTrue));
    const falseValue = parseIntMaybeHex(src && (src.falseValue ?? src.offValue ?? src.disableValue ?? src.valueFalse));

    if (trueValue !== undefined || falseValue !== undefined) {
      if (trueValue !== undefined && v === trueValue) return true;
      if (falseValue !== undefined && v === falseValue) return false;
      if (src && (src.toBoolean === true || src.boolean === true)) return v !== 0;
    }

    // Optional NaN/sentinel handling (device specific).
    // Many Modbus profiles (including SMA) use fixed sentinel values to indicate "NaN" / "not implemented".
    // We only apply this conversion when explicitly enabled per datapoint, to avoid breaking other devices.
    //
    // Usage:
    //   source: { nanToNull: true }  -> use default sentinel per dataType
    //   source: { nanValue: 0x80000000 } -> map this value to null
    const nanValue = parseIntMaybeHex(src && (src.nanValue ?? src.nan));
    if (nanValue !== undefined && v === nanValue) return null;

    if (src && (src.nanToNull === true || src.nanNull === true || src.nanToUndefined === true)) {
      const dt = (src.dataType || '').toString().toLowerCase();

      // Defaults match SMA Modbus TI (S16=0x8000, S32=0x80000000, U16=0xFFFF, U32=0xFFFFFFFF)
      // and common Modbus conventions.
      if ((dt === 'int16' || dt === 's16') && v === -32768) return null;
      if ((dt === 'uint16' || dt === 'u16') && v === 65535) return null;
      if ((dt === 'int32' || dt === 's32') && v === -2147483648) return null;
      if ((dt === 'uint32' || dt === 'u32') && v === 4294967295) return null;
    }

    // Optional bit extraction (useful for packed status registers).
    // Applied BEFORE scaling and sign transforms.
    const bitShift = parseIntMaybeHex(src && src.bitShift);
    const bitMask = parseIntMaybeHex(src && src.bitMask);

    if ((bitShift !== undefined && bitShift !== 0) || bitMask !== undefined) {
      // Ensure integer for bit ops. We intentionally use unsigned operations by default.
      const vi = Math.trunc(v);
      let vv = vi;

      if (bitShift !== undefined && bitShift !== 0) {
        const sh = Math.trunc(bitShift);
        if (sh > 0) {
          if (src && src.bitShiftSigned === true) {
            vv = (vv >> sh);
          } else {
            vv = (vv >>> sh);
          }
        } else if (sh < 0) {
          // Negative shift means left shift
          const lsh = -sh;
          vv = (vv << lsh);
        }
      }

      if (bitMask !== undefined) {
        const mask = Math.trunc(bitMask);
        vv = (vv & mask);
      }

      v = vv;
    }

    // scaleFactor is applied on read direction (Element -> Channel)
    const sf = this._getScaleFactor(src);
    if (sf) v = applyScale(v, sf);

    if (src.invert === true) v = -v;
    if (src.invertIfSetting && this._shouldInvert(src.invertIfSetting)) v = -v;

    if (src.keepPositive === true) v = Math.max(0, v);
    if (src.keepNegativeAndInvert === true) v = v < 0 ? (-v) : 0;

    if (src.toBoolean === true || src.boolean === true) {
      if (src.trueWhenZero === true || src.booleanWhenZero === true) {
        return v === 0;
      }
      return v !== 0;
    }

    return v;
  }


async readDatapoints(datapoints) {
  if (this._busy) {
    const age = Date.now() - Number(this._busySince || 0);
    const maxBusy = Math.max(Number(this.operationTimeoutMs || 0) * 2, Number(this.timeoutMs || 0) * 3, 10000);
    if (this._busySince && age > maxBusy) {
      const err = this._makeTimeoutError('Modbus poll busy guard', maxBusy, 'E_MODBUS_BUSY_STALE');
      this.adapter.log.warn(`[${this.device?.id || 'modbus'}] Modbus poll was busy for ${age} ms; forcing reconnect and clearing IO queue.`);
      this._busy = false;
      this._busySince = 0;
      this._markDisconnected(err);
    } else {
      return {}; // skip overlapping polls
    }
  }
  this._busy = true;
  this._busySince = Date.now();

  const out = {};

  // Keep numeric raw values separate so we can apply dynamic scale factors after all reads.
  const numRawById = {};
  const srcById = {};

  let optionalFailureCount = 0;
  let lastOptionalReadError = null;

  const groupKey = (fc, g, unitId) => `${this._operationUnitId(unitId)}:${Number(fc)}:${Number(g.start)}:${Number(g.end)}`;
  const groupHasRequiredDp = (g) => {
    if (!this.requiredReadDpIds || !this.requiredReadDpIds.size) return false;
    return (g.items || []).some(item => item && item.dp && this.requiredReadDpIds.has(String(item.dp.id)));
  };
  const warnOptionalGroupFailure = (fc, g, e, unitId) => {
    const key = groupKey(fc, g, unitId);
    const now = Date.now();
    const nextWarnAt = this._readGroupWarnUntil.get(key) || 0;
    if (now < nextWarnAt) return;
    this._readGroupWarnUntil.set(key, now + 60000);
    const msg = (e && e.message) ? e.message : String(e);
    const ids = (g.items || []).map(item => item && item.dp ? item.dp.id : '').filter(Boolean).slice(0, 8).join(', ');
    const uid = this._operationUnitId(unitId);
    this.adapter.log.warn(`[${this.device?.id || 'modbus'}] Optional Modbus read group failed and will be skipped temporarily: UID${uid} FC${fc} ${g.start}-${g.end}${ids ? ` (${ids}${(g.items || []).length > 8 ? ', ...' : ''})` : ''}: ${msg}`);
  };

  const groupFallbackOffsets = (g) => {
    const items = Array.isArray(g?.items) ? g.items : [];
    if (!items.length) return [];
    let common = null;
    for (const item of items) {
      const offsets = normalizeAddressFallbackOffsets(item && item.src);
      if (!offsets.length) return [];
      if (common === null) {
        common = offsets.slice();
      } else {
        common = common.filter(v => offsets.includes(v));
      }
      if (!common.length) return [];
    }
    return common || [];
  };

  const shouldSkipGroup = (fc, g, unitId) => {
    if (!this.continueOnReadError || !this.skipFailedReadGroupsMs) return false;
    const until = this._readGroupSkipUntil.get(groupKey(fc, g, unitId)) || 0;
    return until > Date.now();
  };

  const handleGroupReadError = async (fc, g, e, unitId) => {
    const isRequired = groupHasRequiredDp(g);

    if (isTransportError(e)) {
      this._markDisconnected(e);
      // Reset the TCP/serial handle so the next command starts with a clean session.
      try { await this.disconnect(); } catch (_) {}

      // Only reconnect inside the same poll when the failed group is optional and may be skipped.
      // For required live groups we throw immediately; DeviceRuntime will mark the device offline
      // and the next scheduled poll performs a clean reconnect. This avoids reconnect-then-close
      // races after a required timeout.
      if (this.continueOnReadError && !isRequired) {
        try { await this.ensureConnected(); } catch (_) {}
      }
    }

    if (!this.continueOnReadError || isRequired) {
      throw e;
    }

    optionalFailureCount += 1;
    lastOptionalReadError = e;
    if (this.skipFailedReadGroupsMs > 0) {
      this._readGroupSkipUntil.set(groupKey(fc, g, unitId), Date.now() + this.skipFailedReadGroupsMs);
    }
    warnOptionalGroupFailure(fc, g, e, unitId);
    return null;
  };

  try {
    await this.ensureConnected();

    // SunSpec: if a template uses SunSpec model addressing we need the model map (ID -> start offset).
    // We scan the model chain once (cheap) and then resolve absolute addresses per datapoint.
    const needsSunSpec = (datapoints || []).some(dp => {
      const s = getReadSource(dp);
      return s && s.sunspecModel !== undefined && s.sunspecModel !== null;
    });
    if (needsSunSpec) {
      try { await this._maybeScanSunSpecModels(); } catch (_) {}
    }

    const readItems = (datapoints || []).map(dp => {
      const src = getReadSource(dp);
      if (!src) return null;
      let fc = Number(src.fc);
      // SunSpec templates may auto-detect whether registers are exposed via FC3 or FC4.
      if ((src.sunspecModel !== undefined && src.sunspecModel !== null) && (this._sunSpecFc === 3 || this._sunSpecFc === 4)) {
        fc = this._sunSpecFc;
      }
      if (![1, 2, 3, 4].includes(fc)) return null;
      const addr = this._addr(src);
      // SunSpec models can be optional; if a referenced model does not exist,
      // _addr() returns NaN (for address=0). Skip those datapoints gracefully.
      if (!Number.isFinite(addr)) return null;
      const len = Number(src.length || 1);
      const unitId = this._sourceUnitId(src);
      return { dp, src, addr, len, fc, unitId };
    }).filter(Boolean);

    // Collect all referenced scale factor datapoints (e.g. <X>_SF)
    const scaleFactorRefs = new Set();
    for (const it of readItems) {
      if (it?.src?.scaleFactorRef) scaleFactorRefs.add(String(it.src.scaleFactorRef));
    }

    const byBus = new Map();
    for (const it of readItems) {
      const fc = Number(it.fc);
      const unitId = this._operationUnitId(it.unitId);
      const key = `${unitId}:${fc}`;
      if (!byBus.has(key)) byBus.set(key, { fc, unitId, items: [] });
      byBus.get(key).items.push(it);
    }

    for (const { fc, unitId, items } of byBus.values()) {
      if (fc === 1) {
        // Coils
        const groups = buildGroups(items, 2000);
        for (const g of groups) {
          if (shouldSkipGroup(fc, g, unitId)) continue;
          const len = g.end - g.start + 1;
          let res;
          try {
            res = await this._mbReadCoils(g.start, len, unitId);
          } catch (e) {
            res = await handleGroupReadError(fc, g, e, unitId);
            if (!res) continue;
          }
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
          if (shouldSkipGroup(fc, g, unitId)) continue;
          const len = g.end - g.start + 1;
          let res;
          try {
            res = await this._mbReadDiscreteInputs(g.start, len, unitId);
          } catch (e) {
            res = await handleGroupReadError(fc, g, e, unitId);
            if (!res) continue;
          }
          const bits = res.data || [];
          for (const item of g.items) {
            const off = item.addr - g.start;
            out[item.dp.id] = !!bits[off];
          }
        }
        continue;
      }

      // Registers
      const groups = buildGroups(items, this.maxReadRegs, {
        allowGaps: !this.strictContiguousReads,
        isolateItems: this.isolateReadDatapoints,
      });
      for (const g of groups) {
        if (shouldSkipGroup(fc, g, unitId)) continue;
        const len = g.end - g.start + 1;

        let regs;
        try {
          if (fc === 3) {
            regs = (await this._mbReadHoldingRegisters(g.start, len, unitId)).data || [];
          } else {
            regs = (await this._mbReadInputRegisters(g.start, len, unitId)).data || [];
          }
        } catch (e) {
          let fallbackReadOk = false;
          if (isModbusIllegalAddressOrValue(e)) {
            for (const off of groupFallbackOffsets(g)) {
              const fbStart = Number(g.start) + Number(off);
              if (!Number.isFinite(fbStart) || fbStart < 0) continue;
              try {
                if (fc === 3) {
                  regs = (await this._mbReadHoldingRegisters(fbStart, len, unitId)).data || [];
                } else {
                  regs = (await this._mbReadInputRegisters(fbStart, len, unitId)).data || [];
                }
                fallbackReadOk = true;
                break;
              } catch (_) {
                // Try the next explicitly configured fallback offset, if any.
              }
            }
          }
          if (!fallbackReadOk) {
            const res = await handleGroupReadError(fc, g, e, unitId);
            if (!res) continue;
            regs = res.data || [];
          }
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
            const dt = String(src.dataType || '').toLowerCase();
            const wantsNull = !!(src.nanToNull === true || src.nanNull === true || src.nanToUndefined === true);

            // Common not-available sentinel for U64 values: all words 0xFFFF.
            // Without this guard such values become a huge string and ioBroker rejects the
            // state update if the datapoint is declared as type=number.
            if (wantsNull && dt === 'uint64' && raw === 0xFFFFFFFFFFFFFFFFn) {
              out[dp.id] = null;
              continue;
            }

            const conv = bigIntToNumberOrString(raw);
            if (typeof conv === 'string') {
              if (src.bigIntToNullOnOverflow === true || src.uint64OverflowToNull === true) {
                out[dp.id] = null;
                continue;
              }
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

    // If every requested group failed or was skipped, surface the last failure so the
    // device state still reflects a real communication problem.
    if (Object.keys(out).length === 0 && Object.keys(numRawById).length === 0 && optionalFailureCount > 0 && lastOptionalReadError) {
      throw lastOptionalReadError;
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
  } catch (e) {
    if (isTransportError(e)) {
      this._markDisconnected(e);
    }
    throw e;
  } finally {
    this._busy = false;
    this._busySince = 0;
  }

  return out;
}

  _getTemplateDpById(dpId) {
    if (!dpId) return null;
    const wanted = String(dpId);
    const dps = (this.template && Array.isArray(this.template.datapoints)) ? this.template.datapoints : [];
    return dps.find(d => d && String(d.id) === wanted) || null;
  }

  _getSungrowSignedPowerControlForDp(dpId) {
    const id = String(dpId || '');
    if (!id || !Array.isArray(this._sungrowSignedPowerControls)) return null;
    for (const cfg of this._sungrowSignedPowerControls) {
      if (!cfg || cfg.enabled === false) continue;
      const ids = [];
      if (cfg.triggerDpId) ids.push(String(cfg.triggerDpId));
      if (Array.isArray(cfg.triggerDpIds)) {
        for (const v of cfg.triggerDpIds) if (v !== null && v !== undefined) ids.push(String(v));
      }
      if (ids.includes(id)) return cfg;
    }
    return null;
  }

  async _writeDatapointById(dpId, value) {
    const dp = this._getTemplateDpById(dpId);
    if (!dp) throw new Error(`Sungrow compound write datapoint not found: ${dpId}`);
    if (!(dp.rw === 'rw' || dp.rw === 'wo')) throw new Error(`Sungrow compound write datapoint is not writable: ${dpId}`);
    await this.writeDatapoint(dp, value);
  }

  async _maybeWriteSungrowSignedPowerControl(dp, value) {
    const cfg = this._getSungrowSignedPowerControlForDp(dp && dp.id);
    if (!cfg) return false;

    const currentDpId = String(dp && dp.id ? dp.id : '');
    const powerDpId = String(cfg.powerDpId || cfg.chargeDischargePowerDpId || '').trim();
    const commandDpId = String(cfg.commandDpId || cfg.chargeDischargeCommandDpId || '').trim();
    if (!powerDpId || !commandDpId) throw new Error('Sungrow signed power control requires commandDpId and powerDpId');
    if (powerDpId === currentDpId || commandDpId === currentDpId) {
      throw new Error(`Sungrow signed power control must use helper datapoints different from trigger ${currentDpId}`);
    }

    let signedPowerW = Number(value);
    if (!Number.isFinite(signedPowerW)) throw new Error(`Invalid Sungrow power setpoint: ${value}`);

    const deadbandWRaw = Number(cfg.zeroDeadbandW ?? cfg.deadbandW ?? 0);
    const deadbandW = Number.isFinite(deadbandWRaw) && deadbandWRaw > 0 ? deadbandWRaw : 0;
    const roundedW = Math.round(signedPowerW);
    const absW = Math.abs(roundedW);

    const positiveIsCharge = cfg.positiveIsCharge === true;
    const isStop = absW <= deadbandW;
    const chargeValue = Number(cfg.chargeValue ?? 0xAA);
    const dischargeValue = Number(cfg.dischargeValue ?? 0xBB);
    const stopValue = Number(cfg.stopValue ?? 0xCC);
    const modeValue = cfg.modeValue;

    let commandValue;
    if (isStop) {
      commandValue = stopValue;
    } else {
      const wantsCharge = positiveIsCharge ? (roundedW > 0) : (roundedW < 0);
      commandValue = wantsCharge ? chargeValue : dischargeValue;
    }

    // Optional mode pre-write (e.g. SH: compulsory mode, Logger/iHM: VPP/forced mode).
    if (cfg.modeDpId && modeValue !== undefined && modeValue !== null) {
      await this._writeDatapointById(cfg.modeDpId, modeValue);
    }

    // Optional heartbeat pre-write for external EMS/VPP modes.
    if (cfg.heartbeatDpId && cfg.heartbeatValue !== undefined && cfg.heartbeatValue !== null) {
      await this._writeDatapointById(cfg.heartbeatDpId, cfg.heartbeatValue);
    }

    await this._writeDatapointById(commandDpId, commandValue);

    // Stop commands usually do not need a power write, but writing 0 keeps readback / UI consistent.
    if (!isStop || cfg.writePowerOnStop !== false) {
      await this._writeDatapointById(powerDpId, absW);
    }

    return true;
  }

  async writeDatapoint(dp, value) {
    let writeContext = null;

    const setWriteContext = (src, fc, addr, raw, words, unitId) => {
      writeContext = {
        dpId: String(dp?.id || ''),
        fc: Number(fc),
        unitId: this._operationUnitId(unitId ?? this._sourceUnitId(src)),
        address: Number(addr),
        templateAddress: Number(src?.address),
        length: Number(words || src?.length || 1),
        value: raw,
      };
    };

    const annotateWriteError = (err) => {
      if (!err || typeof err !== 'object') return err;
      try { err.nexowattOperation = 'write'; } catch (_) {}
      try { err.nexowattDpId = String(dp?.id || ''); } catch (_) {}
      if (writeContext && !err._nexowattWriteContextAnnotated) {
        const ctx = `Write ${writeContext.dpId || 'datapoint'} UID${writeContext.unitId} FC${writeContext.fc}@${writeContext.address}` +
          ` len=${writeContext.length}` +
          (Number.isFinite(writeContext.templateAddress) ? ` templateAddress=${writeContext.templateAddress}` : '') +
          ` value=${writeContext.value}`;
        try { err.message = `${ctx} failed: ${err.message || String(err)}`; } catch (_) {}
        try { err._nexowattWriteContextAnnotated = true; } catch (_) {}
      }
      return err;
    };

    const attempt = async () => {
      await this.ensureConnected();

      if (await this._maybeWriteSungrowSignedPowerControl(dp, value)) return;

      const src = getWriteSource(dp);
      if (!src) throw new Error('Datapoint has no Modbus write source');

      // SunSpec: resolve model map (ID -> start offset) so writes can compute absolute addresses.
      if (src.sunspecModel !== undefined && src.sunspecModel !== null) {
        try { await this._maybeScanSunSpecModels(); } catch (_) {}
      }

      // Some devices require an explicit unlock step before accepting write commands.
      // This is enabled via template driverHints.modbus.writeUnlock.
      await this._maybeUnlockForWrite(src);

      const fc = Number(src.fc);
      const addr = this._addr(src);
      const unitId = this._sourceUnitId(src);
      if (!Number.isFinite(addr)) {
        throw new Error(`Invalid Modbus address (SunSpec model missing?) for datapoint ${dp?.id || ''}`);
      }

      if (fc === 5) {
        setWriteContext(src, fc, addr, value, 1, unitId);
        await this._mbWriteCoil(addr, !!value, unitId);
        return;
      }

      if (fc === 15) {
        // Write multiple coils (we support single-coil use as well)
        setWriteContext(src, fc, addr, value, 1, unitId);
        await this._mbWriteCoils(addr, [!!value], unitId);
        return;
      }

      // Prepare numeric value for register writes
      let raw = value;
      if (typeof raw === 'string' && raw.trim() !== '') {
        // allow numeric strings
        const n = Number(raw);
        if (!Number.isNaN(n)) raw = n;
      }

      // Optional explicit boolean value mapping (e.g. Sungrow 0xAA/0x55 switches).
      if (typeof raw === 'boolean') {
        const parseBoolMap = (x) => {
          if (x === null || x === undefined) return undefined;
          if (typeof x === 'number' && Number.isFinite(x)) return x;
          if (typeof x === 'string') {
            const st = x.trim().toLowerCase();
            if (!st) return undefined;
            if (st.startsWith('0x')) {
              const n = parseInt(st, 16);
              return Number.isFinite(n) ? n : undefined;
            }
            const n = Number(st);
            return Number.isFinite(n) ? n : undefined;
          }
          return undefined;
        };
        const trueValue = parseBoolMap(src.trueValue ?? src.onValue ?? src.enableValue ?? src.valueTrue);
        const falseValue = parseBoolMap(src.falseValue ?? src.offValue ?? src.disableValue ?? src.valueFalse);
        if (raw === true && trueValue !== undefined) raw = trueValue;
        if (raw === false && falseValue !== undefined) raw = falseValue;
      }

      // Validate/map before scaling (template constraints are expressed in user/device engineering units).
      raw = applyWriteValueConstraints(raw, src, dp?.id);

      // Undo scaling for write direction (Channel -> Element)
      if (typeof raw === 'number') {
        const sf = this._getScaleFactor(src);
        if (sf) raw = removeScale(raw, sf);
      }

      const wo = src.wordOrder || this.wordOrder;
      const bo = src.byteOrder || this.byteOrder;

      // --- Special case: SolaX VPP Mode 4 requires a single FC16 multi-write starting at 0x00A0 ---
      // The V1.4 VPP protocol doc says *all* mode parameters must be written starting at 0x00A0
      // with a mode-specific length (for mode 4: 5 registers = 0xA0..0xA4). Writing only 0xA1/0xA3
      // individually may be ignored by newer firmware.
      const vpp4 = this._solaxVppMode4;
      const triggerId = (vpp4 && vpp4.triggerDpId) ? String(vpp4.triggerDpId) : 'sET_ACTIVE_POWER';
      if (
        fc === 16 &&
        vpp4 && vpp4.enabled === true &&
        String(dp?.id) === triggerId
      ) {
        const startAddress = Number(vpp4.startAddress ?? 160);
        const modeNum = Number(vpp4.modeNum ?? 4);
        const execDpId = (vpp4.execDurationDpId || 'vPP_WAIT_TIMEOUT').toString();
        const nextDpId = (vpp4.nextMotionDpId || 'vPP_NEXT_MOTION').toString();

        // Defaults (used if state values are not available / invalid)
        const defaultExec = Number(vpp4.defaultExecDuration ?? 600);
        const defaultNext = Number(vpp4.defaultNextMotion ?? 160);

        // Optional per-device overrides via existing datapoint states
        let execDuration = await this._getDpStateNumber(execDpId);
        if (!Number.isFinite(execDuration) || execDuration <= 0) execDuration = defaultExec;
        execDuration = Math.round(execDuration);
        if (execDuration < 0) execDuration = 0;
        if (execDuration > 0xFFFF) execDuration = 0xFFFF;

        let nextMotion = await this._getDpStateNumber(nextDpId);
        if (!Number.isFinite(nextMotion) || nextMotion <= 0) nextMotion = defaultNext;
        nextMotion = Math.round(nextMotion);
        // Valid values per VPP protocol: 0x00A0 (exit VPP) or 0x00A1 (switch to default VPP mode 6)
        if (nextMotion !== 0x00A0 && nextMotion !== 0x00A1) nextMotion = defaultNext;

        // SolaX VPP Mode 4: BatWTarget is an S32. Ensure integer W.
        const powerW = Math.round(Number(raw) || 0);

        // Build register block: [VPPModeNum, BatWTarget_L, BatWTarget_H, ExecDuration, NextMotion]
        const blockRegs = [];
        blockRegs.push(...bufferToRegs(valueToBuffer(modeNum, 'uint16', 2), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(powerW, 'int32', 4), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(execDuration, 'uint16', 2), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(nextMotion, 'uint16', 2), wo, bo));

        const blockAddr = this._addr({ address: startAddress });
        await this._mbWriteRegisters(blockAddr, blockRegs, unitId);
        return;
      }


      // --- Special case: SolaX VPP Mode 8 requires a single FC16 multi-write starting at 0x00A0 ---
      // Mode 8: PV&BAT Individual Setting - Duration Mode
      // The V1.4 VPP protocol doc says *all* mode parameters must be written starting at 0x00A0
      // with a mode-specific length (for mode 8: 8 registers = 0xA0..0xA7). Writing only 0xA2/0xA4
      // individually may be ignored by newer firmware.
      const vpp8 = this._solaxVppMode8;

      // VPP8 should behave like our VPP4 handling: writing a single "main" setpoint datapoint
      // commits *all* required VPP parameters in one FC16 block write.
      //
      // For mode 8 we support BOTH setpoints as triggers:
      //  - PV power target (default dpId: sET_PV_POWER)
      //  - Battery power target (default dpId: vPP8_BATTERY_POWER_TARGET)
      //
      // This keeps EMS integration simple (you can update either PV or BAT with a single write).
      const pvTargetDpId = (vpp8 && (vpp8.pvTargetDpId || vpp8.pvWTargetDpId))
        ? String(vpp8.pvTargetDpId || vpp8.pvWTargetDpId)
        : 'sET_PV_POWER';

      const batTargetDpId = (vpp8 && vpp8.batTargetDpId)
        ? String(vpp8.batTargetDpId)
        : 'vPP8_BATTERY_POWER_TARGET';

      const triggerIds = (() => {
        if (!vpp8) return [pvTargetDpId, batTargetDpId];
        if (Array.isArray(vpp8.triggerDpIds) && vpp8.triggerDpIds.length) {
          return vpp8.triggerDpIds.map(v => String(v)).filter(v => v && v.trim());
        }
        const primary = (vpp8.triggerDpId ? String(vpp8.triggerDpId) : pvTargetDpId).trim();
        const out = [];
        if (primary) out.push(primary);
        // Always include both setpoints unless explicitly overridden via triggerDpIds
        if (pvTargetDpId && !out.includes(pvTargetDpId)) out.push(pvTargetDpId);
        if (batTargetDpId && !out.includes(batTargetDpId)) out.push(batTargetDpId);
        return out;
      })();

      const currentDpId = String(dp?.id ?? '');
      if (
        fc === 16 &&
        vpp8 && vpp8.enabled === true &&
        triggerIds.includes(currentDpId)
      ) {
        const startAddress = Number(vpp8.startAddress ?? 160);
        const modeNum = Number(vpp8.modeNum ?? 8);

        const targetSetTypeDpId = (vpp8.targetSetTypeDpId || 'vPP8_TARGET_SET_TYPE').toString();
        const execDpId = (vpp8.execDurationDpId || 'vPP8_EXEC_DURATION').toString();
        const nextDpId = (vpp8.nextMotionDpId || 'vPP8_NEXT_MOTION').toString();

        // Defaults (used if state values are not available / invalid)
        const defaultTargetSetType = Number(vpp8.defaultTargetSetType ?? 1);
        const defaultPvTarget = Number(vpp8.defaultPvTarget ?? vpp8.defaultPvWTarget ?? 0);
        const defaultBatTarget = Number(vpp8.defaultBatTarget ?? 0);
        const defaultExec = Number(vpp8.defaultExecDuration ?? 600);
        const defaultNext = Number(vpp8.defaultNextMotion ?? 160);

        // TargetSetType (1=reset, 2=update)
        let targetSetType = await this._getDpStateNumber(targetSetTypeDpId);
        if (!Number.isFinite(targetSetType) || targetSetType <= 0) targetSetType = defaultTargetSetType;
        targetSetType = Math.round(targetSetType);
        if (targetSetType < 1) targetSetType = 1;
        if (targetSetType > 2) targetSetType = 2;

        const isPvTrigger = (currentDpId === pvTargetDpId);
        const isBatTrigger = (currentDpId === batTargetDpId);

        // PV Power target is an U32 (W). If PV is not the trigger, take the last known PV target state.
        // If none is available (never written), fall back to a template default.
        let pvWTarget;
        if (isPvTrigger) {
          pvWTarget = Math.round(Number(raw) || 0);
        } else {
          pvWTarget = await this._getDpStateNumber(pvTargetDpId);
          if (!Number.isFinite(pvWTarget)) pvWTarget = defaultPvTarget;
          pvWTarget = Math.round(Number(pvWTarget) || 0);
        }
        if (!Number.isFinite(pvWTarget)) pvWTarget = 0;
        if (pvWTarget < 0) pvWTarget = 0;
        // clamp to uint32 range (practically never reached)
        if (pvWTarget > 0xFFFFFFFF) pvWTarget = 0xFFFFFFFF;

        // Battery power target is an S32 (W) (+ discharge / - charge).
        // If BAT is the trigger, use the written value, otherwise take the last known BAT target state.
        let batWTarget;
        if (isBatTrigger) {
          batWTarget = Math.round(Number(raw) || 0);
        } else {
          batWTarget = await this._getDpStateNumber(batTargetDpId);
          if (!Number.isFinite(batWTarget)) batWTarget = defaultBatTarget;
          batWTarget = Math.round(Number(batWTarget) || 0);
        }
        if (!Number.isFinite(batWTarget)) batWTarget = defaultBatTarget;
        if (batWTarget < -0x80000000) batWTarget = -0x80000000;
        if (batWTarget > 0x7FFFFFFF) batWTarget = 0x7FFFFFFF;

        // ExecDuration (seconds)
        let execDuration = await this._getDpStateNumber(execDpId);
        if (!Number.isFinite(execDuration) || execDuration <= 0) execDuration = defaultExec;
        execDuration = Math.round(execDuration);
        if (execDuration < 0) execDuration = 0;
        if (execDuration > 0xFFFF) execDuration = 0xFFFF;

        // NextMotion (U16)
        let nextMotion = await this._getDpStateNumber(nextDpId);
        if (!Number.isFinite(nextMotion) || nextMotion <= 0) nextMotion = defaultNext;
        nextMotion = Math.round(nextMotion);
        // Valid values per VPP protocol: 0x00A0 (exit VPP) or 0x00A1 (switch to default VPP mode 6)
        if (nextMotion !== 0x00A0 && nextMotion !== 0x00A1) nextMotion = defaultNext;

        // Build register block:
        // [VPPModeNum, TargetSetType, PvWTarget_L/H, BatWTarget_L/H, ExecDuration, NextMotion]
        const blockRegs = [];
        blockRegs.push(...bufferToRegs(valueToBuffer(modeNum, 'uint16', 2), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(targetSetType, 'uint16', 2), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(pvWTarget, 'uint32', 4), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(batWTarget, 'int32', 4), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(execDuration, 'uint16', 2), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(nextMotion, 'uint16', 2), wo, bo));

        const blockAddr = this._addr({ address: startAddress });
        await this._mbWriteRegisters(blockAddr, blockRegs, unitId);
        return;
      }


      // --- Special case: FoxESS Remote Control requires a single FC16 multi-write starting at 46001 ---
      // FoxESS H3 remote control uses:
      //  - 46001: Remote Control (bitfield16)
      //  - 46002: Remote Timeout Set (s)
      //  - 46003..46004: Remote Control Active Power Command (S32, W)
      // Writing only 46003 may be ignored unless 46001/46002 are set accordingly.
      const frc = this._foxessRemoteControl;
      const frcTriggerId = (frc && frc.triggerDpId) ? String(frc.triggerDpId) : 'sET_ACTIVE_POWER';
      if (
        fc === 16 &&
        frc && frc.enabled === true &&
        String(dp?.id) === frcTriggerId
      ) {
        const startAddress = Number(frc.startAddress ?? 46001);
        const timeoutDpId = (frc.timeoutDpId || 'rEMOTE_TIMEOUT_SET').toString();
        const defaultTimeout = Number(frc.defaultTimeout ?? 600);

        // Remote Control bitfield
        // bit0: enable (1)
        // bit1: positive direction (0 = power-generation system, 1 = power-consumption system)
        // bits3:2: controlled target (01 = Battery)
        const enable = Number(frc.enable ?? 1) ? 1 : 0;
        const positiveDirection = Number(frc.positiveDirection ?? 0) ? 1 : 0;
        const target = Number(frc.target ?? 1) & 0x03;

        let remoteControlWord = 0;
        if (enable) remoteControlWord |= 1;
        if (positiveDirection) remoteControlWord |= 2;
        remoteControlWord |= (target << 2);

        // Timeout (seconds) - allow override via existing datapoint state
        let timeout = await this._getDpStateNumber(timeoutDpId);
        if (!Number.isFinite(timeout) || timeout < 0) timeout = defaultTimeout;
        timeout = Math.round(timeout);
        if (timeout < 0) timeout = 0;
        if (timeout > 0xFFFF) timeout = 0xFFFF;

        // Active power command (S32, W) - ensure integer
        const powerW = Math.round(Number(raw) || 0);

        // Build register block: [RemoteControl, TimeoutSet, ActivePowerCmd_L/H]
        const blockRegs = [];
        blockRegs.push(...bufferToRegs(valueToBuffer(remoteControlWord, 'uint16', 2), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(timeout, 'uint16', 2), wo, bo));
        blockRegs.push(...bufferToRegs(valueToBuffer(powerW, 'int32', 4), wo, bo));

        const blockAddr = this._addr({ address: startAddress });
        await this._mbWriteRegisters(blockAddr, blockRegs, unitId);
        return;
      }

      const words = Number(src.length || 1);

      // Generic helper for Modbus profiles where one engineering value must be
      // written repeatedly as a multi-register data type. Example: Alfen SCN max
      // current uses one FLOAT32 per phase and must refresh L1/L2/L3 in one FC16
      // request (6 registers total, 2 words per FLOAT32).
      if (fc === 16 && words > 1 && (src.repeatEncodedValue === true || src.repeatEncodedToLength === true || src.repeatDataTypeValue === true)) {
        const oneWordsRaw = Number(src.repeatValueWords ?? src.valueWords ?? dataTypeWordLength(src.dataType));
        const oneWords = Number.isFinite(oneWordsRaw) && oneWordsRaw > 0 ? Math.trunc(oneWordsRaw) : dataTypeWordLength(src.dataType);
        if (oneWords <= 0 || words % oneWords !== 0) {
          throw new Error(`Invalid repeatEncodedValue layout for ${dp?.id || 'datapoint'}: length=${words}, valueWords=${oneWords}`);
        }
        const singleBuf = valueToBuffer(raw, src.dataType, oneWords * 2);
        const singleRegs = bufferToRegs(singleBuf, wo, bo);
        if (!singleRegs.length) throw new Error(`Cannot encode repeatEncodedValue for ${dp?.id || 'datapoint'}`);
        const regsToWrite = [];
        const repeatCount = Math.trunc(words / singleRegs.length);
        for (let i = 0; i < repeatCount; i++) regsToWrite.push(...singleRegs);
        const offsets = normalizeAddressFallbackOffsets(src);
        const addresses = [addr];
        for (const off of offsets) {
          const a = Number(addr) + Number(off);
          if (Number.isFinite(a) && a >= 0 && !addresses.includes(a)) addresses.push(a);
        }
        let lastErr = null;
        for (const a of addresses) {
          try {
            setWriteContext(src, fc, a, raw, words, unitId);
            await this._mbWriteRegisters(a, regsToWrite.slice(0, words), unitId);
            return;
          } catch (e) {
            lastErr = e;
            if (!isModbusIllegalAddressOrValue(e)) throw e;
          }
        }
        throw lastErr;
      }

      // Generic helper for Modbus profiles where one user-facing setpoint must be
      // written into several consecutive registers with the same value. Example:
      // Mennekes charging-point-network EMS current limit L1/L2/L3 (registers 613..615).
      if (fc === 16 && words > 1 && (src.repeatValue === true || src.repeatToLength === true || src.fillRegisters === true)) {
        const singleBuf = valueToBuffer(raw, src.dataType, 2);
        const singleRegs = bufferToRegs(singleBuf, wo, bo);
        const one = singleRegs.length ? singleRegs[0] : 0;
        const regsToWrite = Array(words).fill(one);
        const offsets = normalizeAddressFallbackOffsets(src);
        const addresses = [addr];
        for (const off of offsets) {
          const a = Number(addr) + Number(off);
          if (Number.isFinite(a) && a >= 0 && !addresses.includes(a)) addresses.push(a);
        }
        let lastErr = null;
        for (const a of addresses) {
          try {
            setWriteContext(src, fc, a, raw, words, unitId);
            await this._mbWriteRegisters(a, regsToWrite, unitId);
            return;
          } catch (e) {
            lastErr = e;
            if (!isModbusIllegalAddressOrValue(e)) throw e;
          }
        }
        throw lastErr;
      }

      const buf = valueToBuffer(raw, src.dataType, words * 2);
      const regs = bufferToRegs(buf, wo, bo);

      const fallbackAddresses = (() => {
        const offsets = normalizeAddressFallbackOffsets(src);
        const out = [addr];
        for (const off of offsets) {
          const a = Number(addr) + Number(off);
          if (Number.isFinite(a) && a >= 0 && !out.includes(a)) out.push(a);
        }
        return out;
      })();

      if (fc === 6) {
        if (regs.length < 1) throw new Error('FC6 requires one register');
        let lastErr = null;
        for (const a of fallbackAddresses) {
          try {
            setWriteContext(src, fc, a, raw, 1, unitId);
            await this._mbWriteRegister(a, regs[0], unitId);
            return;
          } catch (e) {
            lastErr = e;
            if (!isModbusIllegalAddressOrValue(e)) throw e;
          }
        }
        throw lastErr;
      }

      if (fc === 16) {
        let lastErr = null;
        for (const a of fallbackAddresses) {
          try {
            setWriteContext(src, fc, a, raw, words, unitId);
            await this._mbWriteRegisters(a, regs, unitId);
            return;
          } catch (e) {
            lastErr = e;
            if (!isModbusIllegalAddressOrValue(e)) throw e;
          }
        }
        throw lastErr;
      }

      throw new Error(`Unsupported write FC=${fc}`);
    };

    try {
      await attempt();
      return;
    } catch (e) {
      // Transport errors are often recoverable by forcing a reconnect and retrying once.
      if (isTransportError(e)) {
        this._markDisconnected(e);
        try {
          await attempt();
          return;
        } catch (e2) {
          if (isTransportError(e2)) {
            this._markDisconnected(e2);
          }
          throw annotateWriteError(e2);
        }
      }
      throw annotateWriteError(e);
    }
  }
}

module.exports = { ModbusDriver };
