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

function template(id) {
  const t = templatesDoc.templates.find(item => item && item.id === id);
  assert.ok(t, `missing template ${id}`);
  return t;
}

function dp(t, id) {
  const item = t.datapoints.find(entry => entry && entry.id === id);
  assert.ok(item, `missing datapoint ${id} in ${t.id}`);
  return item;
}

function unitAndPdu(unitId, address, values) {
  const out = Buffer.alloc(1 + 1 + 2 + 2 + 1 + values.length * 2);
  out.writeUInt8(unitId & 0xFF, 0);
  out.writeUInt8(16, 1);
  out.writeUInt16BE(address & 0xFFFF, 2);
  out.writeUInt16BE(values.length & 0xFFFF, 4);
  out.writeUInt8(values.length * 2, 6);
  values.forEach((word, index) => out.writeUInt16BE(word & 0xFFFF, 7 + index * 2));
  return out;
}

function loadDriver() {
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

const ModbusDriver = loadDriver();
const adapter = { log: { debug() {}, info() {}, warn() {}, error() {} } };

function createDriver(t) {
  const driver = new ModbusDriver(adapter, {
    id: `test-${t.id}`,
    protocol: 'modbusTcp',
    templateId: t.id,
    connection: {
      host: '127.0.0.1',
      port: 502,
      // Deliberately wrong stale settings: Alfen templates must override/ignore them.
      unitId: 99,
      addressOffset: 1,
    },
  }, t, {});
  driver.ensureConnected = async () => true;
  return driver;
}

test('runtime/admin templates are synchronized and ACE profiles are present', () => {
  assert.equal(adminRaw, runtimeRaw);
  assert.ok(template('evcs.alfen.ng9xx.ace.socket1.modbusTcp'));
  assert.ok(template('evcs.alfen.ng9xx.ace.socket2.modbusTcp'));
  assert.ok(template('evcs.alfen.ng9xx.ace.station.modbusTcp'));
});

test('socket profiles use the exact ACE protocol address, Unit-ID and mixed-endian layout', () => {
  for (const [id, unitId] of [
    ['evcs.alfen.ng9xx.ace.socket1.modbusTcp', 1],
    ['evcs.alfen.ng9xx.ace.socket2.modbusTcp', 2],
  ]) {
    const t = template(id);
    const current = dp(t, 'sET_CHARGING_CURRENT');
    assert.equal(current.source.write.fc, 16);
    assert.equal(current.source.write.address, 1209); // document 1210 minus one
    assert.equal(current.source.write.length, 2);
    assert.equal(current.source.write.dataType, 'float32');
    assert.equal(current.source.write.unitId, unitId);
    assert.equal(current.source.write.wordOrder, 'le');
    assert.equal(current.source.write.byteOrder, 'be');

    const phase = dp(t, 'cHARGE_USING_PHASES');
    assert.equal(phase.source.write.address, 1214); // document 1215 minus one
    assert.equal(phase.source.write.unitId, unitId);

    const repeatTargets = t.driverHints.modbus.postWriteRepeat.targets.map(x => x.dpId);
    assert.ok(!repeatTargets.includes('sET_CHARGING_CURRENT'), 'current must not be duplicated by both post-repeat and watchdog');
    assert.ok(repeatTargets.includes('cHARGE_USING_PHASES'));
  }
});

test('socket current writes produce the exact Unit-ID + FC16 PDU bytes', async () => {
  const t = template('evcs.alfen.ng9xx.ace.socket1.modbusTcp');
  const driver = createDriver(t);
  assert.equal(driver.unitId, 1, 'fixed template Unit-ID must override stale config');
  assert.equal(driver.manualAddressOffset, 0, 'Alfen protocol addresses must ignore stale address offsets');

  const writes = [];
  driver._mbWriteRegisters = async (address, values, unitId) => writes.push({ address, values: values.slice(), unitId });

  await driver.writeDatapoint(dp(t, 'sET_CHARGING_CURRENT'), 16);
  await driver.writeDatapoint(dp(t, 'sET_CHARGING_CURRENT'), 5); // clamps to IEC minimum 6 A
  await driver.writeDatapoint(dp(t, 'sET_CHARGING_CURRENT'), 0);

  assert.deepEqual(writes, [
    { address: 1209, values: [0x0000, 0x4180], unitId: 1 },
    { address: 1209, values: [0x0000, 0x40C0], unitId: 1 },
    { address: 1209, values: [0x0000, 0x0000], unitId: 1 },
  ]);

  assert.equal(
    unitAndPdu(1, writes[0].address, writes[0].values).toString('hex'),
    '011004b900020400004180',
  );
});

test('socket 2 writes the same register pair using Unit-ID 2', async () => {
  const t = template('evcs.alfen.ng9xx.ace.socket2.modbusTcp');
  const driver = createDriver(t);
  assert.equal(driver.unitId, 2);
  assert.equal(driver.manualAddressOffset, 0);

  const writes = [];
  driver._mbWriteRegisters = async (address, values, unitId) => writes.push({ address, values: values.slice(), unitId });
  await driver.writeDatapoint(dp(t, 'sET_CHARGING_CURRENT'), 16);

  assert.deepEqual(writes, [{ address: 1209, values: [0x0000, 0x4180], unitId: 2 }]);
  assert.equal(unitAndPdu(2, 1209, writes[0].values).toString('hex'), '021004b900020400004180');
});

test('station profile is a real SCN profile and writes all three phases atomically on Unit-ID 200', async () => {
  const t = template('evcs.alfen.ng9xx.ace.station.modbusTcp');
  assert.equal(t.alfen.controlMode, 'scn');
  assert.equal(t.alfen.scnPrimaryControl, true);
  assert.equal(t.driverHints.modbus.unitIdDefault, 200);

  const combined = dp(t, 'sCN_MAX_CURRENT');
  assert.equal(combined.rw, 'wo');
  assert.equal(combined.source.write.fc, 16);
  assert.equal(combined.source.write.address, 1416); // document 1417 minus one
  assert.equal(combined.source.write.length, 6);
  assert.equal(combined.source.write.unitId, 200);
  assert.equal(combined.source.write.repeatEncodedValue, true);
  assert.equal(combined.source.write.repeatValueWords, 2);
  assert.equal(combined.source.write.round, true);
  assert.equal(combined.source.write.integer, true);
  assert.equal(combined.source.write.zeroOrMinValue, 6);

  assert.equal(dp(t, 'sCN_MAX_CURRENT_L1').source.write.address, 1416);
  assert.equal(dp(t, 'sCN_MAX_CURRENT_L2').source.write.address, 1418);
  assert.equal(dp(t, 'sCN_MAX_CURRENT_L3').source.write.address, 1420);
  assert.equal(dp(t, 'sCN_REMAINING_VALID_TIME_L1').source.read.address, 1422);
  assert.equal(dp(t, 'sCN_SAFE_CURRENT').source.read.address, 1428);
  assert.equal(dp(t, 'sCN_MAX_CURRENT_ENABLE').source.read.address, 1430);

  const driver = createDriver(t);
  assert.equal(driver.unitId, 200);
  assert.equal(driver.manualAddressOffset, 0);
  const writes = [];
  driver._mbWriteRegisters = async (address, values, unitId) => writes.push({ address, values: values.slice(), unitId });

  await driver.writeDatapoint(combined, 16);
  await driver.writeDatapoint(combined, 13.3); // documented step size is 1 A
  await driver.writeDatapoint(combined, 5); // positive values below IEC minimum clamp to 6 A
  assert.deepEqual(writes, [
    {
      address: 1416,
      values: [0x0000, 0x4180, 0x0000, 0x4180, 0x0000, 0x4180],
      unitId: 200,
    },
    {
      address: 1416,
      values: [0x0000, 0x4150, 0x0000, 0x4150, 0x0000, 0x4150],
      unitId: 200,
    },
    {
      address: 1416,
      values: [0x0000, 0x40C0, 0x0000, 0x40C0, 0x0000, 0x40C0],
      unitId: 200,
    },
  ]);
  assert.equal(
    unitAndPdu(200, 1416, writes[0].values).toString('hex'),
    'c810058800060c000041800000418000004180',
  );
});

test('manual Alfen write rejections are no longer silently swallowed', () => {
  const source = fs.readFileSync(path.join(root, 'lib/deviceRuntime.js'), 'utf8');
  assert.match(source, /this\._handleAlfenRejectedControlWrite\(e, aliasTargetDp[\s\S]{0,260}await this\._setError\(e\)/);
  assert.match(source, /this\._handleAlfenRejectedControlWrite\(e, dp && dp\.id[\s\S]{0,180}await this\._setError\(e\)/);
  assert.match(source, /entry\.meta && entry\.meta\.isUserCommand === true[\s\S]{0,180}await this\._setError\(e\)/);
});

test('driver emits an exact accepted-write trace without claiming that ACE applied it', () => {
  const source = fs.readFileSync(path.join(root, 'lib/drivers/modbus.js'), 'utf8');
  assert.match(source, /Alfen Modbus write accepted:/);
  assert.match(source, /Check the ACE accounted\/enabled and valid-time readbacks to confirm application/);
});
