'use strict';

// Real MQTT.js/TCP protocol regression. No connection to customer equipment.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const fixture = require('./fixtures/tesvolt-ems-screenshot.json');
let mqttAvailable = false;
let packets;
try { require.resolve('mqtt'); packets = require('mqtt-packet'); mqttAvailable = true; } catch (_) {}

async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function broker(t, exactOnly = false) {
  const sockets = new Set();
  const published = [];
  const subscribed = [];
  const retained = structuredClone(fixture.messages);
  for (const object of Object.values(retained)) {
    if (object.ts_create) object.ts_create = new Date().toISOString();
  }
  function matches(filter, topic) {
    return filter.endsWith('/#') ? topic.startsWith(filter.slice(0, -1)) : filter === topic;
  }
  function send(socket, object) { socket.write(packets.generate(object)); }
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const parser = packets.parser();
    socket.on('data', data => parser.parse(data));
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') send(socket, { cmd: 'connack', returnCode: 0, sessionPresent: false });
      if (packet.cmd === 'subscribe') {
        const grants = packet.subscriptions.map(s => exactOnly &&
          (s.topic.includes('#') || s.topic.startsWith('EMS/V2/') || s.topic === 'EMS/APIVersion') ? 128 : 0);
        send(socket, { cmd: 'suback', messageId: packet.messageId, granted: grants });
        packet.subscriptions.forEach((s, i) => {
          subscribed.push(s.topic);
          if (grants[i] === 128) return;
          for (const [topic, payload] of Object.entries(retained)) {
            if (matches(s.topic, topic)) send(socket, { cmd: 'publish', topic, payload: JSON.stringify(payload), qos: 0, retain: true });
          }
        });
      }
      if (packet.cmd === 'publish') published.push({ topic: packet.topic, payload: packet.payload.toString(), retain: packet.retain });
      if (packet.cmd === 'pingreq') send(socket, { cmd: 'pingresp' });
      if (packet.cmd === 'disconnect') socket.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    url: `mqtt://127.0.0.1:${server.address().port}`, published, subscribed,
    breakConnections() { for (const socket of sockets) socket.destroy(); },
    broadcast(topic, payload) {
      for (const socket of sockets) send(socket, { cmd: 'publish', topic, payload: JSON.stringify(payload), qos: 0, retain: false });
    },
  };
}

function driverFor(t, url, connection = {}) {
  const { MqttDriver } = require('../lib/drivers/mqtt');
  const template = require('../lib/templates.json').templates.find(t => t.id === 'ess.tesvolt.iotGateway.mqttV2');
  const values = new Map();
  let alive = 0;
  const adapter = {
    namespace: 'nexowatt-devices.0',
    log: { debug() {}, info() {}, warn() {}, error() {} },
    async setStateAsync(id, state) { values.set(id, state.val); },
  };
  const driver = new MqttDriver(adapter, { id: 'tcp-test', connection: { url, ...connection } },
    template, {}, dp => dp.id, () => null, () => { alive += 1; });
  t.after(async () => { await driver.disconnect(); });
  return { driver, values, alive: () => alive };
}

for (const exactOnly of [false, true]) {
  test(`TESVOLT real MQTT transport receives screenshot EMS topics with ${exactOnly ? 'exact-topic ACL fallback' : 'wildcard subscription'} and publishes nothing`,
    { skip: !mqttAvailable && 'Run npm install for real MQTT transport tests', timeout: 10000 }, async t => {
      const b = await broker(t, exactOnly);
      const h = driverFor(t, b.url, { reconnectPeriodMs: 50 });
      await h.driver.connect();
      await until(() => h.values.get('bATTERY_SOC') === 34.5, 'Screenshot SOC did not arrive through MQTT.js');
      await h.driver._messageQueue;
      assert.equal(h.values.get('aCTIVE_POWER'), -20);
      assert.equal(h.values.get('aLLOWED_CHARGE_POWER'), 92000);
      assert.equal(h.values.get('bATTERY_SYSTEM_STATE_TEXT'), 'restricted');
      assert.equal(h.values.get('bIFI_SERIAL_NUMBER'), 'TEST-BIFI');
      assert.equal(h.values.get('mQTT_ACTIVE_TOPIC_PREFIX'), 'EMS/');
      assert.equal(h.values.get('mQTT_SUBSCRIPTION_OK'), true);
      assert.ok(h.alive() > 0);
      assert.ok(b.subscribed.includes('EMS/#'));
      if (exactOnly) assert.ok(b.subscribed.includes('EMS/Battery/Energy'));
      const subscriptionCount = b.subscribed.length;
      b.breakConnections();
      await until(() => b.subscribed.length > subscriptionCount, 'MQTT did not resubscribe after reconnect');
      await h.driver._messageQueue;
      await assert.rejects(h.driver.writeDatapoint(h.driver.dpById.get('sET_ACTIVE_POWER'), 0), /monitoring only/);
      await h.driver.disconnect();
      assert.equal(b.published.length, 0);
    });
}

test('TESVOLT real MQTT transport sends EMS power commands with limits and full payload after explicit control setup',
  { skip: !mqttAvailable && 'Run npm install for real MQTT transport tests', timeout: 10000 }, async t => {
    const b = await broker(t);
    const h = driverFor(t, b.url, { tesvoltTopicMode: 'ems', tesvoltControlEnabled: true });
    await h.driver.connect();
    await until(() => h.values.get('bATTERY_SOC') === 34.5, 'No telemetry');
    await h.driver._messageQueue;
    const dp = h.driver.dpById.get('sET_ACTIVE_POWER');
    await assert.rejects(h.driver.writeDatapoint(dp, 5000), /supported_control/);
    // These are explicit simulated manufacturer capabilities, absent in the screenshot.
    b.broadcast('EMS/Inverter/Parameters', { supported_control: ['Power', 'Reactive_Power', 'State'] });
    b.broadcast('EMS/Battery/SystemState', { System_State: 'normal', ts_create: new Date(Date.now() + 1).toISOString() });
    await until(() => h.values.get('bATTERY_SYSTEM_STATE_TEXT') === 'normal', 'No normal state');
    await h.driver._messageQueue;
    await h.driver.writeDatapoint(dp, 100000);
    await until(() => b.published.some(p => JSON.parse(p.payload).Power === -92000), 'Clamped command did not reach broker');
    const command = b.published.find(p => JSON.parse(p.payload).Power === -92000);
    assert.equal(command.topic, 'EMS/Inverter/Control');
    assert.deepEqual(JSON.parse(command.payload), { Power: -92000, Reactive_Power: 0, State: 'grid_connected' });
    assert.equal(command.retain, false);
    assert.ok(b.published.every(p => p.topic === 'EMS/Inverter/Control'));
    await h.driver.disconnect();
  });
