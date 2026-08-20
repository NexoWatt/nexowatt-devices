'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const runtimeRaw = fs.readFileSync(path.join(root, 'lib/templates.json'), 'utf8');
const adminRaw = fs.readFileSync(path.join(root, 'admin/templates.json'), 'utf8');
const templatesDoc = JSON.parse(runtimeRaw);

const connectorIds = [
  'evcs.oem.modbusV1003.connector1',
  'evcs.oem.modbusV1003.connector2',
];

function template(id) {
  const value = templatesDoc.templates.find((item) => item && item.id === id);
  assert.ok(value, `missing template ${id}`);
  return value;
}

function dp(t, id) {
  const value = (t.datapoints || []).find((item) => item && item.id === id);
  assert.ok(value, `missing datapoint ${id} in ${t.id}`);
  return value;
}

function readSource(item) {
  const rootSource = item && item.source;
  assert.ok(rootSource && rootSource.kind === 'modbus', `${item && item.id}: missing Modbus source`);
  return { ...rootSource, ...(rootSource.read || {}) };
}

function writeSource(item) {
  const rootSource = item && item.source;
  assert.ok(rootSource && rootSource.kind === 'modbus', `${item && item.id}: missing Modbus source`);
  assert.ok(rootSource.write, `${item && item.id}: missing write source`);
  return { ...rootSource, ...rootSource.write };
}

function loadModbusDriver() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'modbus-serial') return class ModbusRTU {};
    if (request === 'serialport') return { SerialPort: class SerialPort {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = require.resolve('../lib/drivers/modbus');
    delete require.cache[modulePath];
    return require('../lib/drivers/modbus').ModbusDriver;
  } finally {
    Module._load = originalLoad;
  }
}

function loadDeviceRuntime() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'modbus-serial') return class ModbusRTU {};
    if (request === 'serialport') return { SerialPort: class SerialPort {} };
    if (request === 'mqtt') return { connect() { throw new Error('not used in OEM alias test'); } };
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

const ModbusDriver = loadModbusDriver();
const DeviceRuntime = loadDeviceRuntime();
const log = { debug() {}, info() {}, warn() {}, error() {} };

function createDriver(t, connection = {}) {
  const driver = new ModbusDriver({ log }, {
    id: `test-${t.id}`,
    protocol: 'modbusTcp',
    templateId: t.id,
    connection: {
      host: '127.0.0.1',
      port: 502,
      unitId: 7,
      addressOffset: 1,
      wordOrder: 'be',
      byteOrder: 'be',
      ...connection,
    },
  }, t, {});
  driver.ensureConnected = async () => true;
  return driver;
}

function buildAliases(t, id = 'evcs-test') {
  const runtime = new DeviceRuntime({ log }, {
    id,
    templateId: t.id,
    category: t.category,
    manufacturer: t.manufacturer,
    protocol: 'modbusTcp',
    connection: {},
  }, t, {});
  for (const item of t.datapoints || []) {
    runtime.dpById.set(item.id, item);
    runtime.dpByStateRelId.set(runtime.relStateId(item), item);
  }
  const definitions = runtime._buildAliasDefinitions();
  const prefix = `devices.${id}.aliases.`;
  const byPath = new Map();
  for (const definition of definitions) {
    if (definition && String(definition.relId).startsWith(prefix)) {
      byPath.set(String(definition.relId).slice(prefix.length), definition);
    }
  }
  return { runtime, byPath };
}

function alias(byPath, pathName) {
  const value = byPath.get(pathName);
  assert.ok(value, `missing alias ${pathName}`);
  return value;
}

function assertRead(t, id, expected) {
  const source = readSource(dp(t, id));
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(source[key], value, `${t.id}/${id}: ${key}`);
  }
}

function assertWrite(t, id, expected) {
  const source = writeSource(dp(t, id));
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(source[key], value, `${t.id}/${id}: ${key}`);
  }
}

test('runtime/admin catalogs are identical and contain both V10.03 connector templates', () => {
  assert.equal(adminRaw, runtimeRaw);
  for (const id of connectorIds) {
    const t = template(id);
    assert.equal(t.category, 'EVCS');
    assert.equal(t.manufacturer, 'OEM / Modbus V10.03');
    assert.deepEqual(t.protocols, ['modbusTcp']);
    assert.equal(t.aliasContract.deviceClass, 'evCharger');
    assert.equal(t.source.document, 'ModBus&TCP-protocol_V10.03-V6.xlsx');
    assert.match(t.source.manufacturerNote, /no manufacturer/i);
  }
});

test('universal input-register map matches the supplied V10.03 workbook', () => {
  for (const id of connectorIds) {
    const t = template(id);
    assertRead(t, 'sERIAL_NUMBER', { fc: 4, address: 0x0000, length: 16, dataType: 'string' });
    assertRead(t, 'gUN_COUNT', { fc: 4, address: 0x0010, length: 1, dataType: 'uint16' });
    assertRead(t, 'cOMMUNICATION_TIMEOUT_MS', { fc: 4, address: 0x0011, length: 1, dataType: 'uint16' });
    assertRead(t, 'fALLBACK_CURRENT', { fc: 4, address: 0x0012, length: 1, dataType: 'uint16' });
    assertWrite(t, 'fALLBACK_CURRENT', { fc: 16, address: 0x0012, length: 1, dataType: 'uint16' });
    assertRead(t, 'cHARGE_MODE', { fc: 4, address: 0x0013, length: 1, dataType: 'uint16' });
    assertWrite(t, 'cHARGE_MODE', { fc: 16, address: 0x0013, length: 1, dataType: 'uint16', allowedValues: [1, 3] });
    assertRead(t, 'sTATION_STATUS', { fc: 4, address: 0x001A, length: 1, dataType: 'uint16' });
    assertRead(t, 'cHARGE_POINT_SET_POWER', { fc: 4, address: 0x001B, length: 2, dataType: 'uint32' });
    assertWrite(t, 'cHARGE_POINT_SET_POWER', { fc: 16, address: 0x001B, length: 2, dataType: 'uint32' });
  }

  assertRead(template(connectorIds[0]), 'uNIVERSAL_CONNECTOR_STATE', { fc: 4, address: 0x0014 });
  assertRead(template(connectorIds[0]), 'uNIVERSAL_CABLE_STATE', { fc: 4, address: 0x0015 });
  assertRead(template(connectorIds[0]), 'uNIVERSAL_ERROR_CODE', { fc: 4, address: 0x0016 });
  assertRead(template(connectorIds[1]), 'uNIVERSAL_CONNECTOR_STATE', { fc: 4, address: 0x0017 });
  assertRead(template(connectorIds[1]), 'uNIVERSAL_CABLE_STATE', { fc: 4, address: 0x0018 });
  assertRead(template(connectorIds[1]), 'uNIVERSAL_ERROR_CODE', { fc: 4, address: 0x0019 });
});

test('connector-specific maps use the exact 0x01xx and 0x02xx register blocks', () => {
  for (const [id, base] of [[connectorIds[0], 0x0100], [connectorIds[1], 0x0200]]) {
    const t = template(id);
    assertRead(t, 'gUN_TYPE', { fc: 3, address: base + 0x00, length: 1, dataType: 'uint16' });
    assertRead(t, 'eVSE_STATE', { fc: 3, address: base + 0x01, length: 1, dataType: 'uint16' });
    assertRead(t, 'eRROR_CODE', { fc: 3, address: base + 0x02, length: 1, dataType: 'uint16' });
    assertRead(t, 'dC_VOLTAGE', { fc: 3, address: base + 0x03, length: 1, dataType: 'uint16', scaleFactor: -1 });
    assertRead(t, 'dC_CURRENT', { fc: 3, address: base + 0x04, length: 1, dataType: 'uint16', scaleFactor: -1 });
    assertRead(t, 'vOLTAGE_L1', { fc: 3, address: base + 0x05, scaleFactor: -1 });
    assertRead(t, 'cURRENT_L1', { fc: 3, address: base + 0x08, scaleFactor: -1 });
    assertRead(t, 'pOWER_L1', { fc: 3, address: base + 0x0B, length: 2, dataType: 'uint32' });
    assertRead(t, 'pOWER_L2', { fc: 3, address: base + 0x0D, length: 2, dataType: 'uint32' });
    assertRead(t, 'pOWER_L3', { fc: 3, address: base + 0x0F, length: 2, dataType: 'uint32' });
    assertRead(t, 'aCTIVE_POWER', { fc: 3, address: base + 0x11, length: 2, dataType: 'uint32' });
    assertRead(t, 'aCTIVE_PRODUCTION_ENERGY', { fc: 3, address: base + 0x13, length: 2, dataType: 'uint32', scaleFactor: -1 });
    assertRead(t, 'eNERGY_SESSION', { fc: 3, address: base + 0x15, length: 2, dataType: 'uint32', scaleFactor: -1 });
    assertRead(t, 'cHARGING_DURATION', { fc: 3, address: base + 0x17, length: 2, dataType: 'uint32' });
    assertRead(t, 'mAX_SUPPORTED_CURRENT', { fc: 3, address: base + 0x19, scaleFactor: -1 });
    assertRead(t, 'mIN_SUPPORTED_CURRENT', { fc: 3, address: base + 0x1A, scaleFactor: -1 });
    assertRead(t, 'mAX_SUPPORTED_POWER', { fc: 3, address: base + 0x1B, length: 2, dataType: 'uint32' });
    assertRead(t, 'cABLE_CURRENT_LIMIT', { fc: 3, address: base + 0x1D, length: 1, dataType: 'uint16' });
    assertRead(t, 'cP_VOLTAGE', { fc: 3, address: base + 0x1E, scaleFactor: -1 });
    assertRead(t, 'cP_STATE', { fc: 3, address: base + 0x1F });
    assertRead(t, 'pLUG_STATE', { fc: 3, address: base + 0x20 });
    assertRead(t, 'cHARGE_COMMAND', { fc: 3, address: base + 0x21, length: 1, dataType: 'uint16' });
    assertWrite(t, 'cHARGE_COMMAND', { fc: 16, address: base + 0x21, length: 1, dataType: 'uint16', allowedValues: [1, 2] });
    assertRead(t, 'eV_SET_CHARGE_POWER_LIMIT', { fc: 3, address: base + 0x22, length: 2, dataType: 'uint32' });
    assertWrite(t, 'eV_SET_CHARGE_POWER_LIMIT', { fc: 16, address: base + 0x22, length: 2, dataType: 'uint32' });
  }
});

test('driver hints force zero-based protocol addresses without forcing a site-specific Unit-ID', () => {
  for (const id of connectorIds) {
    const t = template(id);
    const hints = t.driverHints.modbus;
    assert.equal(hints.unitIdDefault, 1);
    assert.notEqual(hints.enforceUnitIdDefault, true);
    assert.notEqual(hints.enforceTcpUnitIdDefault, true);
    assert.equal(hints.forceAddressOffset, 0);
    assert.equal(hints.disableAddressFallbackOffsets, true);
    assert.equal(hints.disableOffByOneFallback, true);
    assert.equal(hints.restoreSetpointsOnStart.enabled, false);
    assert.equal(hints.postWriteRepeat.enabled, false);
    assert.equal(hints.setpointKeepalive.enabled, false);
    assert.equal(t.driverHints.polling.fastIntervalMs, 2000);
  }

  const driver = createDriver(template(connectorIds[0]));
  assert.equal(driver.unitId, 7, 'configured Unit-ID must remain available for OEM installations');
  assert.equal(driver.manualAddressOffset, 0, 'template addresses are already protocol addresses');
});

test('FC16 start/stop and 32-bit power writes produce exact register blocks', async () => {
  for (const [id, base] of [[connectorIds[0], 0x0100], [connectorIds[1], 0x0200]]) {
    const t = template(id);
    const driver = createDriver(t);
    const writes = [];
    driver._mbWriteRegisters = async (address, values, unitId) => {
      writes.push({ address, values: values.slice(), unitId });
    };

    await driver.writeDatapoint(dp(t, 'cHARGE_COMMAND'), 1);
    await driver.writeDatapoint(dp(t, 'cHARGE_COMMAND'), 2);
    await driver.writeDatapoint(dp(t, 'eV_SET_CHARGE_POWER_LIMIT'), 50000);
    await driver.writeDatapoint(dp(t, 'cHARGE_POINT_SET_POWER'), 100000);

    assert.deepEqual(writes, [
      { address: base + 0x21, values: [1], unitId: 7 },
      { address: base + 0x21, values: [2], unitId: 7 },
      { address: base + 0x22, values: [0x0000, 0xC350], unitId: 7 },
      { address: 0x001B, values: [0x0001, 0x86A0], unitId: 7 },
    ]);
  }
});

test('unsafe or undocumented command values are rejected before Modbus transmission', async () => {
  const t = template(connectorIds[0]);
  const driver = createDriver(t);
  driver._mbWriteRegisters = async () => {
    throw new Error('write must not be reached for an invalid value');
  };

  await assert.rejects(driver.writeDatapoint(dp(t, 'cHARGE_COMMAND'), 0), /Invalid Modbus write value/);
  await assert.rejects(driver.writeDatapoint(dp(t, 'cHARGE_COMMAND'), 3), /Invalid Modbus write value/);
  await assert.rejects(driver.writeDatapoint(dp(t, 'eV_SET_CHARGE_POWER_LIMIT'), -1), /below minimum 0/);
  await assert.rejects(driver.writeDatapoint(dp(t, 'cHARGE_MODE'), 2), /Invalid Modbus write value/);
});

test('canonical run aliases map boolean commands to protocol values 1=start and 2=stop', () => {
  for (const id of connectorIds) {
    const { runtime, byPath } = buildAliases(template(id));
    assert.equal(runtime.aliasDeviceClass, 'evCharger');
    const run = alias(byPath, 'v1.ctrl.run');
    const enable = alias(byPath, 'ctrl.chargeEnable');
    const powerLimit = alias(byPath, 'v1.ctrl.powerLimitW');

    for (const control of [run, enable]) {
      assert.equal(control.writeDpId, 'cHARGE_COMMAND');
      assert.equal(control.commandOnlyAlias, true);
      assert.equal(control.preferCommandValue, true);
      assert.equal(control.toDevice(true), 1);
      assert.equal(control.toDevice(false), 2);
      assert.equal(control.toDevice('start'), 1);
      assert.equal(control.toDevice('stop'), 2);
      assert.equal(control.toDevice(0), 2);
      assert.equal(control.fromDevice(1), true);
      assert.equal(control.fromDevice(2), false);
    }

    assert.equal(powerLimit.writeDpId, 'eV_SET_CHARGE_POWER_LIMIT');
    assert.equal(powerLimit.toDevice(12345.4), 12345);
    assert.equal(powerLimit.toDevice(-1), undefined);
    assert.equal(byPath.has('v1.ctrl.currentLimitA'), false, 'fallback current is not the live charging setpoint');
    assert.equal(runtime.aliasContractInfo.capabilities.includes('write.currentLimitA'), false);
  }
});

test('AC/DC status, current and safety aliases use the protocol state and gun type correctly', () => {
  const { byPath } = buildAliases(template(connectorIds[0]));
  const statusCode = alias(byPath, 'v1.r.statusCode');
  const statusText = alias(byPath, 'v1.r.statusText');
  const available = alias(byPath, 'v1.r.available');
  const vehicleConnected = alias(byPath, 'v1.r.vehicleConnected');
  const charging = alias(byPath, 'v1.r.charging');
  const fault = alias(byPath, 'v1.alarm.fault');
  const current = alias(byPath, 'v1.r.currentA');
  assert.equal(alias(byPath, 'v1.r.voltageL1').dpId, 'vOLTAGE_L1');
  assert.equal(alias(byPath, 'v1.r.voltageL2').dpId, 'vOLTAGE_L2');
  assert.equal(alias(byPath, 'v1.r.voltageL3').dpId, 'vOLTAGE_L3');
  assert.equal(alias(byPath, 'v1.r.currentL1').dpId, 'cURRENT_L1');
  assert.equal(alias(byPath, 'v1.r.currentL2').dpId, 'cURRENT_L2');
  assert.equal(alias(byPath, 'v1.r.currentL3').dpId, 'cURRENT_L3');

  const base = {
    sTATION_STATUS: 0,
    eVSE_STATE: 0,
    eRROR_CODE: 0,
    pLUG_STATE: 0,
    gUN_TYPE: 2,
    cURRENT_L1: 7.1,
    cURRENT_L2: 7.3,
    cURRENT_L3: 7.2,
    dC_CURRENT: 0,
    aCTIVE_POWER: 5100,
  };

  assert.equal(statusCode.get(base), 0);
  assert.equal(statusText.get(base), 'Idle');
  assert.equal(available.get(base), true);
  assert.equal(vehicleConnected.get(base), false);
  assert.equal(charging.get(base), false);
  assert.equal(fault.get(base), false);
  assert.equal(current.get(base), 7.3);

  const acCharging = { ...base, eVSE_STATE: 2, pLUG_STATE: 1 };
  assert.equal(statusText.get(acCharging), 'Charging');
  assert.equal(vehicleConnected.get(acCharging), true);
  assert.equal(charging.get(acCharging), true);

  const dcCharging = { ...acCharging, gUN_TYPE: 3, dC_CURRENT: 118.6 };
  assert.equal(current.get(dcCharging), 118.6);

  assert.equal(available.get({ ...base, eVSE_STATE: 7 }), false);
  assert.equal(fault.get({ ...base, eRROR_CODE: 42 }), true);
  assert.equal(fault.get({ ...base, eVSE_STATE: 5 }), true);
  assert.equal(fault.get({ ...base, sTATION_STATUS: 2 }), true);
});

test('energy aliases normalize the workbook 0.1 kWh counters to the v1 Wh contract', () => {
  const { byPath } = buildAliases(template(connectorIds[0]));
  const total = alias(byPath, 'v1.r.energyTotal');
  const session = alias(byPath, 'v1.r.energySession');
  assert.equal(total.unit, 'Wh');
  assert.equal(session.unit, 'Wh');
  assert.equal(total.fromDevice(12.3), 12300);
  assert.equal(session.fromDevice(1.2), 1200);
});
