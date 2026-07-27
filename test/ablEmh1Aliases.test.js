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
  assert.equal(runtime.driverHints.modbus.adaptiveReadSplit, false);
  assert.deepEqual(runtime.driverHints.modbus.requiredReadDpIds, ['eVSE_STATE']);
  assert.deepEqual(runtime.driverHints.modbus.serialDefaults, {
    baudRate: 38400,
    parity: 'even',
    dataBits: 8,
    stopBits: 1,
    enforce: false,
  });
});

test('ABL full-current and Icmax registers use the exact EVCC2/3 API addresses and scaling', () => {
  const template = getTemplate(runtimeTemplates);
  const l1 = getDp(template, 'cURRENT_L1');
  const l2 = getDp(template, 'cURRENT_L2');
  const l3 = getDp(template, 'cURRENT_L3');
  const appliedPwm = getDp(template, 'iCMAX_DUTY_CYCLE_PCT');
  const setPwm = getDp(template, 'sET_ICMAX_DUTY_CYCLE_PCT');
  const modifyState = getDp(template, 'mODIFY_STATE');

  assert.deepEqual([l1.source.address, l2.source.address, l3.source.address], [0x0030, 0x0031, 0x0032]);
  for (const dp of [l1, l2, l3]) {
    assert.equal(dp.source.fc, 3);
    assert.equal(dp.source.length, 1);
    assert.equal(dp.source.dataType, 'uint16');
    assert.equal(dp.source.scaleFactor, -1);
    assert.equal(dp.source.nanValue, 0x03E8);
    assert.equal(dp.source.readRequestGroup, 'abl-0x002e-r5');
  }

  assert.equal(appliedPwm.source.address, 0x002F);
  assert.equal(appliedPwm.source.bitMask, 0x0FFF);
  assert.equal(appliedPwm.source.scaleFactor, -1);
  assert.equal(setPwm.source.write.fc, 16);
  assert.equal(setPwm.source.write.address, 0x0014);
  assert.equal(setPwm.source.write.length, 1);
  assert.equal(setPwm.source.write.scaleFactor, -1);
  assert.equal(setPwm.source.write.finite, true);
  assert.deepEqual(setPwm.source.write.allowedRanges, [[8, 100]]);

  assert.equal(modifyState.source.write.fc, 16);
  assert.equal(modifyState.source.write.address, 0x0005);
  assert.equal(modifyState.source.write.length, 1);
  assert.deepEqual(modifyState.source.write.allowedValues, [
    '0x3838', '0x5A5A', '0xA1A1', '0xE0E0', '0xE2E2', '0xF1F1',
  ]);
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

  // 0x03E8 is the documented sentinel and is decoded as null, not 100 A.
  const unavailable = { cURRENT_L1: null, cURRENT_L2: null, cURRENT_L3: null };
  assert.equal(alias(byPath, 'r.currentA').get(unavailable), undefined);
  assert.equal(alias(byPath, 'r.currentPhaseSumA').get(unavailable), undefined);
});

test('ABL Ampere command truncates to the documented 0.1-percent PWM values', () => {
  const { byPath } = createAliasDefinitions();
  const control = alias(byPath, 'ctrl.currentLimitA');

  assert.equal(control.dpId, 'iCMAX_DUTY_CYCLE_PCT');
  assert.equal(control.writeDpId, 'sET_ICMAX_DUTY_CYCLE_PCT');
  assert.equal(control.commandOnlyAlias, true);
  assert.equal(control.preferCommandValue, true);

  assert.equal(control.toDevice(0), 100);
  assert.equal(control.toDevice(1), 100);
  assert.equal(control.toDevice(5.9), 100);
  assert.equal(control.toDevice(6), 10);
  assert.equal(control.toDevice(10), 16.6); // ABL document: raw 0x00A6
  assert.equal(control.toDevice(16), 26.6); // ABL example/readback: raw 0x010A
  assert.equal(control.toDevice(32), 53.3);
  assert.equal(control.toDevice(51), 85);

  // 51..52.75 A cannot be represented without overshooting. Keep the safe 51 A value.
  assert.equal(control.toDevice(51.1), 85);
  assert.equal(control.toDevice(52.7), 85);
  assert.equal(control.toDevice(52.75), 85.1);
  assert.equal(control.toDevice(80), 96);
  assert.equal(control.toDevice(200), 96);
});

test('ABL PWM readback treats 0, 5 and 100 percent as special values, not analogue current', () => {
  const { byPath } = createAliasDefinitions();
  const readback = alias(byPath, 'r.currentLimitA');
  const control = alias(byPath, 'ctrl.currentLimitA');
  const pwm = alias(byPath, 'ctrl.currentLimitPct');

  assert.equal(readback.dpId, 'iCMAX_DUTY_CYCLE_PCT');
  assert.equal(readback.fromDevice(0), 0);
  assert.equal(readback.fromDevice(5), 0); // 5% = digital communication required
  assert.equal(readback.fromDevice(8), 0);
  assert.equal(readback.fromDevice(9.9), 0);
  assert.equal(readback.fromDevice(10), 6);
  assert.equal(readback.fromDevice(85), 51);
  assert.equal(readback.fromDevice(85.1), 52.8);
  assert.equal(readback.fromDevice(96), 80);
  assert.equal(readback.fromDevice(97), 0);
  assert.equal(readback.fromDevice(100), 0); // no current allowed

  assert.equal(control.fromDevice(5), 0);
  assert.equal(control.fromDevice(26.6), 16);

  assert.equal(pwm.dpId, 'iCMAX_DUTY_CYCLE_PCT');
  assert.equal(pwm.writeDpId, 'sET_ICMAX_DUTY_CYCLE_PCT');
  assert.equal(pwm.commandOnlyAlias, true);
  assert.equal(pwm.preferCommandValue, true);
  assert.equal(pwm.toDevice(0), 100);
  assert.equal(pwm.toDevice(8), 10);
  assert.equal(pwm.toDevice(10), 10);
  assert.equal(pwm.toDevice(26.67), 26.6);
  assert.equal(pwm.toDevice(96), 96);
  assert.equal(pwm.toDevice(99), 100);
});

test('ABL run and charge-enable pause via 100 percent PWM and restore the last active limit', () => {
  const { byPath } = createAliasDefinitions();
  const controlA = alias(byPath, 'ctrl.currentLimitA');
  const controlPct = alias(byPath, 'ctrl.currentLimitPct');
  const run = alias(byPath, 'ctrl.run');
  const chargeEnable = alias(byPath, 'ctrl.chargeEnable');
  const released = alias(byPath, 'r.chargingReleased');
  const waiting = alias(byPath, 'r.waitingForCurrent');

  for (const def of [run, chargeEnable]) {
    assert.equal(def.dpId, 'iCMAX_DUTY_CYCLE_PCT');
    assert.equal(def.writeDpId, 'sET_ICMAX_DUTY_CYCLE_PCT');
    assert.notEqual(def.writeDpId, 'mODIFY_STATE');
    assert.equal(def.commandOnlyAlias, true);
    assert.equal(def.preferCommandValue, true);
  }

  // No previous current command: release at the IEC minimum 10% = 6 A.
  assert.equal(run.toDevice(true), 10);
  assert.equal(run.toDevice(false), 100);
  assert.equal(run.toDevice(true), 10);

  // A direct PWM command is remembered across pause/resume.
  assert.equal(controlPct.toDevice(26.67), 26.6);
  assert.equal(run.toDevice(false), 100);
  assert.equal(run.toDevice(true), 26.6);
  assert.equal(chargeEnable.toDevice(false), 100);
  assert.equal(chargeEnable.toDevice(true), 26.6);

  // An Ampere command is also remembered in its encoded PWM form.
  assert.equal(controlA.toDevice(32), 53.3);

  // A temporary lower charger-side readback must not replace the EMS command
  // that pause/resume is expected to restore.
  assert.equal(alias(byPath, 'r.currentLimitPct').fromDevice(10), 10);
  assert.equal(alias(byPath, 'r.currentLimitA').fromDevice(10), 6);
  assert.equal(run.toDevice(false), 100);
  assert.equal(run.toDevice(true), 53.3);

  assert.equal(run.fromDevice(53.3), true);
  assert.equal(run.fromDevice(100), false);
  assert.equal(released.fromDevice(53.3), true);
  assert.equal(released.fromDevice(5), false);
  assert.equal(waiting.fromDevice(100), true);
  assert.equal(waiting.fromDevice(96), false);
});
