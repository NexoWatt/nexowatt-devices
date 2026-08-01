'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const runtimeTemplates = JSON.parse(fs.readFileSync(path.join(root, 'lib/templates.json'), 'utf8'));
const adminTemplates = JSON.parse(fs.readFileSync(path.join(root, 'admin/templates.json'), 'utf8'));
const templateId = 'evcs.abl.emh1.evcc2_3.modbusAscii';

function getTemplate(doc) {
  const template = doc.templates.find(item => item && item.id === templateId);
  assert.ok(template, `missing template ${templateId}`);
  return template;
}

function getDp(template, id) {
  const dp = template.datapoints.find(item => item && item.id === id);
  assert.ok(dp, `missing datapoint ${id}`);
  return dp;
}

function loadDeviceRuntime() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'modbus-serial') return class ModbusRTU {};
    if (request === 'serialport') return { SerialPort: class SerialPort {} };
    if (request === 'mqtt') return { connect() { throw new Error('not used in ABL alias test'); } };
    if (request === 'axios') return {};
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = require.resolve('../lib/deviceRuntime');
    delete require.cache[modulePath];
    return require('../lib/deviceRuntime').DeviceRuntime;
  } finally {
    Module._load = originalLoad;
  }
}

function createAliasDefinitions() {
  const DeviceRuntime = loadDeviceRuntime();
  const template = getTemplate(runtimeTemplates);
  const adapter = { log: { debug() {}, info() {}, warn() {}, error() {} } };
  const runtime = new DeviceRuntime(adapter, {
    id: 'evcs1',
    templateId,
    category: 'EVCS',
    manufacturer: 'ABL',
    connection: {},
  }, template, {});

  for (const dp of template.datapoints) {
    runtime.dpById.set(dp.id, dp);
    runtime.dpByStateRelId.set(runtime.relStateId(dp), dp);
  }

  const definitions = runtime._buildAliasDefinitions();
  const byPath = new Map();
  for (const def of definitions) {
    const prefix = 'devices.evcs1.aliases.';
    if (def && String(def.relId).startsWith(prefix)) {
      byPath.set(String(def.relId).slice(prefix.length), def);
    }
  }
  return { runtime, definitions, byPath };
}

function alias(byPath, pathName) {
  const def = byPath.get(pathName);
  assert.ok(def, `missing alias ${pathName}`);
  return def;
}

test('runtime and admin contain the same audited ABL eMH1 template', () => {
  const runtime = getTemplate(runtimeTemplates);
  const admin = getTemplate(adminTemplates);
  assert.deepEqual(admin, runtime);
  assert.equal(runtime.category, 'EVCS');
  assert.equal(runtime.manufacturer, 'ABL');
  assert.deepEqual(runtime.protocols, ['modbusAscii']);
  assert.equal(runtime.driverHints.modbus.unitIdDefault, 1);
  assert.equal(runtime.driverHints.modbus.asciiResponseStart, '>');
});

test('ABL full-current and Icmax registers use the exact EVCC2/3 API addresses and scaling', () => {
  const template = getTemplate(runtimeTemplates);
  const l1 = getDp(template, 'cURRENT_L1');
  const l2 = getDp(template, 'cURRENT_L2');
  const l3 = getDp(template, 'cURRENT_L3');
  const appliedPwm = getDp(template, 'iCMAX_DUTY_CYCLE_PCT');
  const setPwm = getDp(template, 'sET_ICMAX_DUTY_CYCLE_PCT');

  assert.deepEqual([l1.source.address, l2.source.address, l3.source.address], [48, 49, 50]);
  for (const dp of [l1, l2, l3]) {
    assert.equal(dp.source.fc, 3);
    assert.equal(dp.source.length, 1);
    assert.equal(dp.source.dataType, 'uint16');
    assert.equal(dp.source.scaleFactor, -1);
    assert.equal(dp.source.nanValue, 1000);
  }

  assert.equal(appliedPwm.source.address, 47);
  assert.equal(appliedPwm.source.bitMask, 4095);
  assert.equal(appliedPwm.source.scaleFactor, -1);
  assert.equal(setPwm.source.write.fc, 16);
  assert.equal(setPwm.source.write.address, 20);
  assert.equal(setPwm.source.write.length, 1);
  assert.equal(setPwm.source.write.scaleFactor, -1);
  assert.equal(setPwm.source.write.finite, true);
  assert.deepEqual(setPwm.source.write.allowedRanges, [[8, 100]]);
  assert.equal(setPwm.min, 8);
  assert.equal(setPwm.max, 100);
  assert.equal(setPwm.step, 0.1);

  const modifyState = getDp(template, 'mODIFY_STATE');
  assert.match(modifyState.name, /Expert\/service/);
});

test('ABL live-current aliases compare per-phase current instead of summing amperes', () => {
  const { byPath } = createAliasDefinitions();
  const balanced = {
    cURRENT_L1: 5.5,
    cURRENT_L2: 5.5,
    cURRENT_L3: 5.5,
    iCMAX_DUTY_CYCLE_PCT: 10,
  };

  assert.equal(alias(byPath, 'r.currentL1').dpId, 'cURRENT_L1');
  assert.equal(alias(byPath, 'r.currentL2').dpId, 'cURRENT_L2');
  assert.equal(alias(byPath, 'r.currentL3').dpId, 'cURRENT_L3');

  assert.equal(alias(byPath, 'r.currentA').get(balanced), 5.5);
  assert.equal(alias(byPath, 'r.currentTotalA').get(balanced), 5.5);
  assert.equal(alias(byPath, 'r.currentPhaseSumA').get(balanced), 16.5);
  assert.equal(alias(byPath, 'r.power').get(balanced), 3795);
  assert.equal(alias(byPath, 'r.powerEstimated').get(balanced), 3795);

  const singlePhase = { cURRENT_L1: 5.5, cURRENT_L2: 0, cURRENT_L3: 0 };
  assert.equal(alias(byPath, 'r.currentA').get(singlePhase), 5.5);
  assert.equal(alias(byPath, 'r.currentTotalA').get(singlePhase), 5.5);
  assert.equal(alias(byPath, 'r.currentPhaseSumA').get(singlePhase), 5.5);
  assert.equal(alias(byPath, 'r.power').get(singlePhase), 1265);

  const unbalanced = { cURRENT_L1: 5.4, cURRENT_L2: 5.8, cURRENT_L3: 5.5 };
  assert.equal(alias(byPath, 'r.currentA').get(unbalanced), 5.8);
  assert.equal(alias(byPath, 'r.currentTotalA').get(unbalanced), 5.8);
  assert.equal(alias(byPath, 'r.currentPhaseSumA').get(unbalanced), 16.7);
});

test('ABL current-limit command converts EOS amperes to exact vendor PWM values', () => {
  const { byPath } = createAliasDefinitions();
  const readback = alias(byPath, 'r.currentLimitA');
  const control = alias(byPath, 'ctrl.currentLimitA');

  assert.equal(readback.dpId, 'iCMAX_DUTY_CYCLE_PCT');
  assert.equal(control.writeDpId, 'sET_ICMAX_DUTY_CYCLE_PCT');
  assert.equal(control.preferCommandValue, true);

  // ABL/IEC 61851 normal-current range: D = I / 0.6. Truncation keeps
  // the advertised maximum at or below the requested EMS current.
  assert.equal(control.toDevice(0), 100);
  assert.equal(control.toDevice(5.9), 100);
  assert.equal(control.toDevice(6), 10);
  assert.equal(control.toDevice(10), 16.6);
  assert.equal(control.toDevice(16), 26.6);
  assert.equal(control.toDevice(32), 53.3);
  assert.equal(control.toDevice(51), 85);

  // High-current range and safe handling of the IEC discontinuity.
  assert.equal(control.toDevice(52), 85);
  assert.equal(control.toDevice(52.75), 85.1);
  assert.equal(control.toDevice(80), 96);
  assert.equal(control.toDevice(90), 96);

  assert.equal(readback.fromDevice(0), 0);
  assert.equal(readback.fromDevice(10), 6);
  assert.equal(readback.fromDevice(16.6), 10);
  assert.equal(readback.fromDevice(26.6), 16);
  assert.equal(readback.fromDevice(85), 51);
  assert.equal(readback.fromDevice(85.1), 52.8);
  assert.equal(readback.fromDevice(96), 80);
  assert.equal(readback.fromDevice(100), 0);
});

test('ABL pause/resume uses Icmax 100 percent and never the service-state register', () => {
  const { runtime, byPath } = createAliasDefinitions();
  const run = alias(byPath, 'ctrl.run');
  const chargeEnable = alias(byPath, 'ctrl.chargeEnable');
  const pctControl = alias(byPath, 'ctrl.currentLimitPct');
  const waiting = alias(byPath, 'r.waitingForCurrent');
  const released = alias(byPath, 'r.chargingReleased');

  for (const def of [run, chargeEnable]) {
    assert.equal(def.dpId, 'iCMAX_DUTY_CYCLE_PCT');
    assert.equal(def.writeDpId, 'sET_ICMAX_DUTY_CYCLE_PCT');
    assert.notEqual(def.writeDpId, 'mODIFY_STATE');
    assert.equal(def.toDevice(false), 100);
    assert.equal(def.fromDevice(100), false);
    assert.equal(def.fromDevice(10), true);
  }

  // With no earlier current command, resume safely at 6 A = 10 %.
  assert.equal(run.toDevice(true), 10);

  // After an active 16-A command, pause must not erase the resume value.
  runtime._rememberCommandedValue('sET_ICMAX_DUTY_CYCLE_PCT', 26.6);
  assert.equal(run.toDevice(true), 26.6);
  runtime._rememberCommandedValue('sET_ICMAX_DUTY_CYCLE_PCT', 100);
  assert.equal(run.toDevice(false), 100);
  assert.equal(run.toDevice(true), 26.6);
  assert.equal(chargeEnable.toDevice(true), 26.6);

  assert.equal(pctControl.toDevice(26.67), 26.6);
  assert.equal(pctControl.toDevice(8), 100);
  assert.equal(pctControl.toDevice(97), 100);
  assert.equal(pctControl.toDevice(100), 100);

  assert.equal(waiting.get({ iCMAX_DUTY_CYCLE_PCT: 100 }), true);
  assert.equal(waiting.get({ iCMAX_DUTY_CYCLE_PCT: 26.6 }), false);
  assert.equal(released.get({ iCMAX_DUTY_CYCLE_PCT: 100 }), false);
  assert.equal(released.get({ iCMAX_DUTY_CYCLE_PCT: 26.6 }), true);
});
