'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const runtimeTemplatesRaw = fs.readFileSync(path.join(root, 'lib/templates.json'), 'utf8');
const adminTemplatesRaw = fs.readFileSync(path.join(root, 'admin/templates.json'), 'utf8');
const templates = JSON.parse(runtimeTemplatesRaw).templates;
const helper = require('./helpers/compatibilityHarness.cjs');

function loadMqttDriver() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'mqtt') return { connect() { throw new Error('connect not used in unit test'); } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = require.resolve('../lib/drivers/mqtt');
    delete require.cache[modulePath];
    return require('../lib/drivers/mqtt').MqttDriver;
  } finally {
    Module._load = originalLoad;
  }
}

const MqttDriver = loadMqttDriver();
const DeviceRuntime = helper.loadDeviceRuntime(path.join(root, 'lib/deviceRuntime.js'));

function templateById(id) {
  const template = templates.find((entry) => entry && entry.id === id);
  assert.ok(template, `missing template ${id}`);
  return template;
}

function createHarness() {
  const states = new Map();
  const stateWrites = [];
  const published = [];
  const subscriptions = [];
  const snapshots = [];
  const connectionEvents = [];
  const logs = [];
  const client = {
    subscribe(topic, options, callback) {
      subscriptions.push({ topic, options });
      if (callback) callback(null);
    },
    publish(topic, payload, options, callback) {
      published.push({ topic, payload: String(payload), options });
      if (callback) callback(null);
    },
  };
  const adapter = {
    log: {
      debug(message) { logs.push({ level: 'debug', message }); },
      info(message) { logs.push({ level: 'info', message }); },
      warn(message) { logs.push({ level: 'warn', message }); },
      error(message) { logs.push({ level: 'error', message }); },
    },
    async setStateAsync(id, state) {
      const copy = { ...state };
      states.set(id, copy);
      stateWrites.push({ id, state: copy });
    },
  };
  return { states, stateWrites, published, subscriptions, snapshots, connectionEvents, logs, client, adapter };
}

function createDriver(template, harness) {
  const driver = new MqttDriver(
    harness.adapter,
    { id: 'tesvolt1', connection: { url: 'mqtt://127.0.0.1:1884' } },
    template,
    {},
    (dp) => `devices.tesvolt1.${dp.id}`,
    () => null,
    () => {},
    async (values, meta) => { harness.snapshots.push({ values, meta }); },
    async (connected, error) => { harness.connectionEvents.push({ connected, error }); },
  );
  driver.client = harness.client;
  driver.connected = true;
  driver._subscribeAll();
  return driver;
}

async function feed(driver, topic, object) {
  const payload = Buffer.from(typeof object === 'string' ? object : JSON.stringify(object));
  await driver._handleMessage(topic, payload);
}

function stateValue(harness, dpId) {
  const state = harness.states.get(`devices.tesvolt1.${dpId}`);
  return state && state.val;
}

function aliasByPath(template, wantedPath) {
  const runtime = helper.buildRuntime(DeviceRuntime, template, 'tesvolt1');
  const prefix = 'devices.tesvolt1.aliases.';
  const definition = runtime._buildAliasDefinitions().find((entry) =>
    entry && String(entry.relId).startsWith(prefix) && String(entry.relId).slice(prefix.length) === wantedPath
  );
  assert.ok(definition, `missing alias ${wantedPath}`);
  return { runtime, definition };
}

function createRuntimeHarness(template) {
  const states = new Map();
  const adapter = {
    namespace: 'nexowatt-devices.0',
    log: { debug() {}, info() {}, warn() {}, error() {} },
    async setStateAsync(id, state) { states.set(id, { ...state }); },
    async getStateAsync() { return null; },
  };
  const runtime = new DeviceRuntime(adapter, {
    id: 'tesvolt1',
    templateId: template.id,
    category: template.category,
    manufacturer: template.manufacturer,
    protocol: 'mqtt',
    connection: {},
  }, template, {});

  for (const dp of template.datapoints || []) {
    runtime.dpById.set(dp.id, dp);
    runtime.dpByStateRelId.set(runtime.relStateId(dp), dp);
  }
  runtime.aliasDefs = runtime._buildAliasDefinitions();
  runtime.aliasByStateRelId = new Map(runtime.aliasDefs.map((definition) => [definition.relId, definition]));
  return { runtime, adapter, states };
}

test('TESVOLT IoT Gateway MQTT V2 template is additive, synchronized and exposes documented topics', () => {
  assert.equal(runtimeTemplatesRaw, adminTemplatesRaw);
  const template = templateById('ess.tesvolt.iotGateway.mqttV2');
  assert.deepEqual(template.protocols, ['mqtt']);
  assert.equal(template.category, 'ESS');
  assert.equal(template.aliasContract.deviceClass, 'storageSystem');
  assert.equal(template.driverHints.heartbeatTimeoutMs, 5000);

  const byId = new Map(template.datapoints.map((dp) => [dp.id, dp]));
  assert.equal(byId.get('aPI_VERSION').source.topic, 'EMS/APIVersion');
  assert.equal(byId.get('aCTIVE_POWER').source.topic, 'EMS/V2/Inverter/Measurements');
  assert.equal(byId.get('aCTIVE_POWER').source.invert, true);
  assert.equal(byId.get('bATTERY_SOC').source.topic, 'EMS/V2/Battery/Energy');
  assert.equal(byId.get('bATTERY_SYSTEM_STATE_TEXT').source.topic, 'EMS/V2/Battery/SystemState');
  assert.equal(byId.get('sET_ACTIVE_POWER').source.topic, 'EMS/V2/Inverter/Control');
  assert.equal(byId.has('dC_CONNECTION_REQUEST'), false, 'DC contactor control stays disabled until semantics are confirmed');

  const group = template.driverHints.mqtt.writeGroups.inverterControl;
  assert.equal(group.topic, 'EMS/V2/Inverter/Control');
  assert.equal(group.qos, 0);
  assert.equal(group.retain, false);
  assert.equal(group.fields.Power.invert, true);
  assert.equal(group.fields.Reactive_Power.value, 0);
  assert.equal(group.fields.State.value, 'grid_connected');
});

test('MQTT driver processes every JSON datapoint sharing one topic instead of only the last one', async () => {
  const harness = createHarness();
  const driver = createDriver(templateById('evcs.openwb.lp1.mqtt.v1'), harness);

  const topic = 'openWB/internal_chargepoint/lp1/get/voltages';
  assert.equal(driver.dpsByTopic.get(topic).length, 3);
  await feed(driver, topic, [231.1, 232.2, 233.3]);
  await feed(driver, topic, [231.1, 232.2, 233.3]);

  assert.equal(stateValue(harness, 'vOLTAGE_L1'), 231.1);
  assert.equal(stateValue(harness, 'vOLTAGE_L2'), 232.2);
  assert.equal(stateValue(harness, 'vOLTAGE_L3'), 233.3);
  assert.equal(
    harness.stateWrites.filter((entry) => entry.id === 'devices.tesvolt1.vOLTAGE_L1').length,
    2,
    'unchanged MQTT samples must still refresh the raw ioBroker state timestamp',
  );
});

test('TESVOLT MQTT JSON topics update all fields, invert power sign and ignore older timestamps', async () => {
  const harness = createHarness();
  const driver = createDriver(templateById('ess.tesvolt.iotGateway.mqttV2'), harness);

  await feed(driver, 'EMS/V2/Inverter/Measurements', {
    ts_create: '2026-08-08T08:00:00.000+02:00',
    U_DC: 992.1,
    U_L1: 242.3,
    U_L2: 243.2,
    U_L3: 243.2,
    Power: -12000,
    Reactive_Power: 360,
  });

  assert.equal(stateValue(harness, 'iNVERTER_DC_VOLTAGE'), 992.1);
  assert.equal(stateValue(harness, 'aC_VOLTAGE_L1'), 242.3);
  assert.equal(stateValue(harness, 'aC_VOLTAGE_L2'), 243.2);
  assert.equal(stateValue(harness, 'aC_VOLTAGE_L3'), 243.2);
  assert.equal(stateValue(harness, 'aCTIVE_POWER'), 12000, 'TESVOLT negative discharge becomes NexoWatt positive discharge');
  assert.equal(stateValue(harness, 'rEACTIVE_POWER'), 360);

  await feed(driver, 'EMS/V2/Inverter/Measurements', {
    ts_create: '2026-08-08T07:59:59.000+02:00',
    U_DC: 100,
    U_L1: 100,
    U_L2: 100,
    U_L3: 100,
    Power: 99999,
    Reactive_Power: 0,
  });
  assert.equal(stateValue(harness, 'aCTIVE_POWER'), 12000, 'older source timestamp must not overwrite newer data');
});

test('TESVOLT canonical ESS aliases expose SOC, signed power, split directions, limits and fault state', () => {
  const template = templateById('ess.tesvolt.iotGateway.mqttV2');
  const runtime = helper.buildRuntime(DeviceRuntime, template, 'tesvolt1');
  const definitions = runtime._buildAliasDefinitions();
  const prefix = 'devices.tesvolt1.aliases.';
  const byPath = new Map(definitions.map((entry) => [String(entry.relId).slice(prefix.length), entry]));

  assert.deepEqual(runtime.aliasContractInfo.missingRequired, []);
  assert.equal(byPath.get('v1.r.soc').get({ bATTERY_SOC: 55.5 }), 55.5);
  assert.equal(byPath.get('v1.r.power').get({ aCTIVE_POWER: 12000 }), 12000);
  assert.equal(byPath.get('v1.r.powerCharge').get({ aCTIVE_POWER: -5000 }), 5000);
  assert.equal(byPath.get('v1.r.powerDischarge').get({ aCTIVE_POWER: 5000 }), 5000);
  assert.equal(byPath.get('v1.r.allowedChargePower').dpId, 'aLLOWED_CHARGE_POWER');
  assert.equal(byPath.get('v1.r.allowedDischargePower').dpId, 'aLLOWED_DISCHARGE_POWER');
  assert.equal(byPath.get('v1.alarm.fault').get({ sYSTEM_FAULT_COUNTERS: 1 }), true);
  assert.equal(byPath.get('v1.ctrl.chargePowerW').toDevice(10000), -10000);
  assert.equal(byPath.get('v1.ctrl.dischargePowerW').toDevice(10000), 10000);
});

test('TESVOLT active-power control publishes documented JSON with sign conversion and dynamic limit clamp', async () => {
  const harness = createHarness();
  const template = templateById('ess.tesvolt.iotGateway.mqttV2');
  const driver = createDriver(template, harness);
  const setpoint = template.datapoints.find((dp) => dp.id === 'sET_ACTIVE_POWER');

  await feed(driver, 'EMS/APIVersion', { APIVersion: 'V2' });
  await feed(driver, 'EMS/V2/Inverter/Parameters', {
    ts_create: '2026-08-08T08:00:00.000+02:00',
    serial_number: 'INV-1',
    supported_measurements: ['Power'],
    supported_states: ['standby', 'grid_connected', 'fault'],
    supported_control: ['Power', 'Reactive_Power', 'State'],
    nominal_charge_power: 92000,
    nominal_discharge_power: 92000,
  });
  await feed(driver, 'EMS/V2/Inverter/Limits', {
    ts_create: '2026-08-08T08:00:01.000+02:00',
    P_Max_Charge: 45000,
    P_Max_Discharge: 45000,
    Q_Max_Q1: 45000,
    Q_Max_Q2: 45000,
    Q_Max_Q3: 45000,
    Q_Max_Q4: 45000,
    S_Max_In: 45000,
    S_Max_Out: 45000,
  });
  await feed(driver, 'EMS/V2/Inverter/State', {
    ts_create: '2026-08-08T08:00:02.000+02:00',
    State: 'grid_connected',
  });
  await feed(driver, 'EMS/V2/Battery/SystemState', {
    ts_create: '2026-08-08T08:00:02.000+02:00',
    System_State: 'normal',
  });

  const discharge = await driver.writeDatapoint(setpoint, 50000);
  assert.equal(discharge.effectiveValue, 45000);
  assert.deepEqual(JSON.parse(harness.published.at(-1).payload), {
    Power: -45000,
    Reactive_Power: 0,
    State: 'grid_connected',
  });
  assert.deepEqual(harness.published.at(-1).options, { qos: 0, retain: false });

  const charge = await driver.writeDatapoint(setpoint, -60000);
  assert.equal(charge.effectiveValue, -45000);
  assert.equal(JSON.parse(harness.published.at(-1).payload).Power, 45000);
  assert.ok(harness.logs.some((entry) => entry.level === 'warn' && entry.message.includes('limited to')));
});

test('TESVOLT non-zero control is gated by API, supported_control and fresh inverter/battery state; zero stays fail-safe', async () => {
  const harness = createHarness();
  const template = templateById('ess.tesvolt.iotGateway.mqttV2');
  const driver = createDriver(template, harness);
  const setpoint = template.datapoints.find((dp) => dp.id === 'sET_ACTIVE_POWER');

  await assert.rejects(() => driver.writeDatapoint(setpoint, 1000), /API V2 required/);
  await assert.rejects(() => driver.writeDatapoint(setpoint, 0), /API V2 required/);

  await feed(driver, 'EMS/APIVersion', { APIVersion: 'V2' });
  const zero = await driver.writeDatapoint(setpoint, 0);
  assert.equal(zero.effectiveValue, 0);
  assert.equal(JSON.parse(harness.published.at(-1).payload).Power, 0);
  await feed(driver, 'EMS/V2/Inverter/Parameters', {
    supported_measurements: ['Power'],
    supported_states: ['grid_connected'],
    supported_control: ['Reactive_Power', 'State'],
  });
  await assert.rejects(() => driver.writeDatapoint(setpoint, 1000), /does not advertise Power/);

  await feed(driver, 'EMS/V2/Inverter/Parameters', {
    supported_measurements: ['Power'],
    supported_states: ['grid_connected'],
    supported_control: ['Power', 'Reactive_Power', 'State'],
  });
  await feed(driver, 'EMS/V2/Inverter/Limits', { P_Max_Charge: 45000, P_Max_Discharge: 45000 });
  await assert.rejects(() => driver.writeDatapoint(setpoint, 1000), /inverter state is stale or missing/);
  await feed(driver, 'EMS/V2/Inverter/State', { State: 'grid_connected' });
  await feed(driver, 'EMS/V2/Battery/SystemState', { System_State: 'restricted' });
  await assert.rejects(() => driver.writeDatapoint(setpoint, 1000), /battery state restricted/);
});

test('TESVOLT power values fail safe to zero on stale data and MQTT heartbeat/offline handling', async () => {
  const harness = createHarness();
  const driver = createDriver(templateById('ess.tesvolt.iotGateway.mqttV2'), harness);

  await feed(driver, 'EMS/V2/Inverter/Measurements', {
    ts_create: '2026-08-08T08:00:00.000+02:00',
    Power: -12000,
    U_DC: 900,
    U_L1: 230,
    U_L2: 230,
    U_L3: 230,
    Reactive_Power: 0,
  });
  assert.equal(stateValue(harness, 'aCTIVE_POWER'), 12000);

  driver.updatedAtByDpId.set('aCTIVE_POWER', Date.now() - 6000);
  await feed(driver, 'EMS/V2/Battery/SystemState', {
    ts_create: '2026-08-08T08:00:10.000+02:00',
    System_State: 'normal',
  });
  assert.equal(stateValue(harness, 'aCTIVE_POWER'), 0, 'stale AC power must be cleared while other topics continue');

  driver.valueCache.aCTIVE_POWER = 8000;
  driver.lastStateWriteByDpId.set('aCTIVE_POWER', 8000);
  await driver.handleOffline('test offline');
  assert.equal(stateValue(harness, 'aCTIVE_POWER'), 0);
  assert.equal(stateValue(harness, 'bATTERY_DC_POWER'), 0);
  assert.equal(harness.snapshots.at(-1).meta.connected, false);
});

test('TESVOLT event-driven snapshots update legacy and v1 storage aliases without polling', async () => {
  const template = templateById('ess.tesvolt.iotGateway.mqttV2');
  const { runtime, states } = createRuntimeHarness(template);

  await runtime._handleMqttSnapshot({
    aCTIVE_POWER: 12000,
    bATTERY_SOC: 55.5,
    aLLOWED_CHARGE_POWER: 45000,
    aLLOWED_DISCHARGE_POWER: 46000,
    sYSTEM_FAULT_COUNTERS: 0,
  }, { connected: true });

  assert.equal(states.get('devices.tesvolt1.aliases.r.power').val, 12000);
  assert.equal(states.get('devices.tesvolt1.aliases.v1.r.power').val, 12000);
  assert.equal(states.get('devices.tesvolt1.aliases.r.soc').val, 55.5);
  assert.equal(states.get('devices.tesvolt1.aliases.v1.r.allowedChargePower').val, 45000);
  assert.equal(states.get('devices.tesvolt1.aliases.comm.connected').val, true);
  assert.equal(states.get('devices.tesvolt1.aliases.v1.alarm.offline').val, false);
});

test('TESVOLT runtime acknowledges the effective clamped value on direct and split power aliases', async () => {
  const template = templateById('ess.tesvolt.iotGateway.mqttV2');
  const { runtime, states } = createRuntimeHarness(template);
  const writes = [];
  runtime.driver = {
    async writeDatapoint(dp, value) {
      writes.push({ dpId: dp.id, value });
      const effectiveValue = Math.sign(value) * Math.min(Math.abs(value), 45000);
      return { effectiveValue };
    },
  };

  const dischargeRel = 'devices.tesvolt1.aliases.v1.ctrl.dischargePowerW';
  await runtime.handleStateChange(`nexowatt-devices.0.${dischargeRel}`, { val: 50000, ack: false });
  assert.deepEqual(writes.at(-1), { dpId: 'sET_ACTIVE_POWER', value: 50000 });
  assert.equal(states.get(dischargeRel).val, 45000);
  assert.equal(states.get('devices.tesvolt1.sET_ACTIVE_POWER').val, 45000);

  const chargeRel = 'devices.tesvolt1.aliases.v1.ctrl.chargePowerW';
  await runtime.handleStateChange(`nexowatt-devices.0.${chargeRel}`, { val: 50000, ack: false });
  assert.deepEqual(writes.at(-1), { dpId: 'sET_ACTIVE_POWER', value: -50000 });
  assert.equal(states.get(chargeRel).val, 45000);
  assert.equal(states.get('devices.tesvolt1.sET_ACTIVE_POWER').val, -45000);
});

test('generic MQTT writes keep the established client queue behaviour while TESVOLT groups require a live connection', async () => {
  const genericHarness = createHarness();
  const genericTemplate = templateById('generic.mqtt');
  const genericDriver = createDriver(genericTemplate, genericHarness);
  genericDriver.connected = false;
  const genericSetpoint = genericTemplate.datapoints.find((dp) => dp.id === 'set');
  await genericDriver.writeDatapoint(genericSetpoint, 12.5);
  assert.equal(genericHarness.published.at(-1).topic, 'device/set');
  assert.equal(genericHarness.published.at(-1).payload, '12.5');

  const tesvoltHarness = createHarness();
  const tesvoltTemplate = templateById('ess.tesvolt.iotGateway.mqttV2');
  const tesvoltDriver = createDriver(tesvoltTemplate, tesvoltHarness);
  tesvoltDriver.connected = false;
  const tesvoltSetpoint = tesvoltTemplate.datapoints.find((dp) => dp.id === 'sET_ACTIVE_POWER');
  await assert.rejects(() => tesvoltDriver.writeDatapoint(tesvoltSetpoint, 0), /MQTT not connected/);
});

