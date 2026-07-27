'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const templatesDoc = JSON.parse(fs.readFileSync(path.join(root, 'lib/templates.json'), 'utf8'));
const templateId = 'evcs.abl.emh1.evcc2_3.modbusAscii';

function getTemplate() {
  const template = templatesDoc.templates.find(item => item && item.id === templateId);
  assert.ok(template, `missing template ${templateId}`);
  return template;
}

function getDp(template, id) {
  const dp = template.datapoints.find(item => item && item.id === id);
  assert.ok(dp, `missing datapoint ${id}`);
  return dp;
}

function loadModules() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'modbus-serial') return class ModbusRTU {};
    if (request === 'serialport') return { SerialPort: class SerialPort {} };
    if (request === 'mqtt') return { connect() { throw new Error('not used in ABL write-frame test'); } };
    if (request === 'axios') return {};
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    for (const rel of [
      '../lib/deviceRuntime',
      '../lib/drivers/modbus',
      '../lib/drivers/modbusAsciiBus',
      '../lib/drivers/modbusRtuBus',
    ]) {
      try { delete require.cache[require.resolve(rel)]; } catch (_) {}
    }
    return {
      DeviceRuntime: require('../lib/deviceRuntime').DeviceRuntime,
      ModbusDriver: require('../lib/drivers/modbus').ModbusDriver,
    };
  } finally {
    Module._load = originalLoad;
  }
}

function adapterStub(logs = []) {
  return {
    log: {
      debug(msg) { logs.push(['debug', String(msg)]); },
      info(msg) { logs.push(['info', String(msg)]); },
      warn(msg) { logs.push(['warn', String(msg)]); },
      error(msg) { logs.push(['error', String(msg)]); },
    },
  };
}

function getCurrentAlias(DeviceRuntime, template) {
  const runtime = new DeviceRuntime(adapterStub(), {
    id: 'evcs1',
    templateId,
    category: 'EVCS',
    manufacturer: 'ABL',
    protocol: 'modbusAscii',
    connection: { unitId: 1 },
  }, template, {});
  for (const dp of template.datapoints) {
    runtime.dpById.set(dp.id, dp);
    runtime.dpByStateRelId.set(runtime.relStateId(dp), dp);
  }
  const rel = runtime._aliasRelId('ctrl.currentLimitA');
  const def = runtime._buildAliasDefinitions().find(item => item && item.relId === rel);
  assert.ok(def, 'missing ctrl.currentLimitA alias');
  return def;
}

function calcLrc(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + (b & 0xFF)) & 0xFF;
  return (0x100 - sum) & 0xFF;
}

function asciiFc16Frame(unitId, address, registers) {
  const regs = [];
  for (const value of registers) {
    const v = Number(value) & 0xFFFF;
    regs.push((v >> 8) & 0xFF, v & 0xFF);
  }
  const qty = registers.length;
  const body = [
    unitId & 0xFF,
    0x10,
    (address >> 8) & 0xFF,
    address & 0xFF,
    (qty >> 8) & 0xFF,
    qty & 0xFF,
    regs.length & 0xFF,
    ...regs,
  ];
  const bytes = [...body, calcLrc(body)];
  return `:${bytes.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
}

async function captureWrite(ModbusDriver, template, dp, engineeringValue) {
  const logs = [];
  const driver = new ModbusDriver(adapterStub(logs), {
    id: 'evcs1',
    templateId,
    protocol: 'modbusAscii',
    connection: { unitId: 1 },
  }, template, {});

  const calls = [];
  driver.ensureConnected = async () => true;
  driver._mbWriteRegisters = async (address, registers, unitId) => {
    calls.push({ address, registers: [...registers], unitId });
    return { address, length: registers.length };
  };

  await driver.writeDatapoint(dp, engineeringValue);
  assert.equal(calls.length, 1);
  return { call: calls[0], logs };
}

test('10 A reproduces the exact ABL document write frame at register 0x0014', async () => {
  const template = getTemplate();
  const { DeviceRuntime, ModbusDriver } = loadModules();
  const controlA = getCurrentAlias(DeviceRuntime, template);
  const setPwm = getDp(template, 'sET_ICMAX_DUTY_CYCLE_PCT');

  const pwm = controlA.toDevice(10);
  assert.equal(pwm, 16.6);

  const { call } = await captureWrite(ModbusDriver, template, setPwm, pwm);
  assert.deepEqual(call, { address: 0x0014, registers: [0x00A6], unitId: 1 });
  assert.equal(asciiFc16Frame(call.unitId, call.address, call.registers), ':0110001400010200A632');
});

test('16 A and pause encode the documented raw Icmax values without rounding upward', async () => {
  const template = getTemplate();
  const { DeviceRuntime, ModbusDriver } = loadModules();
  const controlA = getCurrentAlias(DeviceRuntime, template);
  const setPwm = getDp(template, 'sET_ICMAX_DUTY_CYCLE_PCT');

  const pwm16 = controlA.toDevice(16);
  assert.equal(pwm16, 26.6);
  const write16 = await captureWrite(ModbusDriver, template, setPwm, pwm16);
  assert.deepEqual(write16.call, { address: 0x0014, registers: [0x010A], unitId: 1 });

  const pwmPause = controlA.toDevice(0);
  assert.equal(pwmPause, 100);
  const pause = await captureWrite(ModbusDriver, template, setPwm, pwmPause);
  assert.deepEqual(pause.call, { address: 0x0014, registers: [0x03E8], unitId: 1 });
});

test('raw ABL write datapoints reject undocumented values before any serial command is sent', async () => {
  const template = getTemplate();
  const { ModbusDriver } = loadModules();
  const setPwm = getDp(template, 'sET_ICMAX_DUTY_CYCLE_PCT');
  const modifyState = getDp(template, 'mODIFY_STATE');

  await assert.rejects(
    captureWrite(ModbusDriver, template, setPwm, 7.9),
    /Allowed values\/ranges: 8\.\.100/,
  );
  await assert.rejects(
    captureWrite(ModbusDriver, template, modifyState, 0x1234),
    /Invalid Modbus write value/,
  );

  const validMin = await captureWrite(ModbusDriver, template, setPwm, 8);
  assert.deepEqual(validMin.call, { address: 0x0014, registers: [0x0050], unitId: 1 });

  const validService = await captureWrite(ModbusDriver, template, modifyState, 0xE0E0);
  assert.deepEqual(validService.call, { address: 0x0005, registers: [0xE0E0], unitId: 1 });
});
