'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSungrowResidentialRuntime,
  configureSungrowRuntime,
  pollSungrowFeedbackOnce,
} = require('../lib/sungrowFastFeedbackPatch');

function makeRuntime(rawValue) {
  const states = new Map();
  const batteryDp = {
    id: 'bATTERY_POWER',
    unit: 'W',
    source: {
      kind: 'modbus',
      fc: 3,
      address: 13020,
      length: 1,
      dataType: 'int16',
    },
  };
  const runtime = {
    started: true,
    cfg: { enabled: true, id: 'ess1', templateId: 'ess.sungrow.ResidentialHybridV119' },
    template: {
      id: 'ess.sungrow.ResidentialHybridV119',
      manufacturer: 'Sungrow',
      model: 'Residential Hybrid Inverter',
      driverHints: { modbus: { commandCadenceMs: 250, writeThrottleMs: 1000, minCommandIntervalMs: 1000 } },
    },
    dpById: new Map([['bATTERY_POWER', batteryDp]]),
    aliasDefs: [
      { relId: 'devices.ess1.aliases.r.power', kind: 'dp', dpId: 'bATTERY_POWER' },
      {
        relId: 'devices.ess1.aliases.r.powerCharge',
        kind: 'computed',
        get: values => Math.max(0, -Number(values.bATTERY_POWER || 0)),
      },
      {
        relId: 'devices.ess1.aliases.r.powerDischarge',
        kind: 'computed',
        get: values => Math.max(0, Number(values.bATTERY_POWER || 0)),
      },
    ],
    _getDpById(id) { return this.dpById.get(id); },
    getDatapoints() { return [...this.dpById.values()]; },
    relStateId(dp) { return `devices.ess1.${dp.id}`; },
    _getRoundingDecimals() { return 0; },
    async _setStateCached(id, value) { states.set(id, value); },
    async _tickHeartbeatFromIncomingData() {},
    driver: {
      wordOrder: 'be',
      byteOrder: 'be',
      _addr(src) { return src.address; },
      _sourceUnitId() { return 1; },
      async _mbReadHoldingRegisters() { return { data: [rawValue & 0xffff] }; },
      _applyTransforms(value) { return value; },
    },
    states,
  };
  return runtime;
}

test('detects only the Sungrow residential hybrid runtime', () => {
  const runtime = makeRuntime(500);
  assert.equal(isSungrowResidentialRuntime(runtime), true);
  runtime.template.manufacturer = 'Other';
  assert.equal(isSungrowResidentialRuntime(runtime), false);
});

test('splits write scheduling from the full poll scheduler', () => {
  const runtime = makeRuntime(500);
  assert.equal(configureSungrowRuntime(runtime), true);
  assert.equal(runtime.template.driverHints.modbus.commandCadenceMs, 0);
  assert.equal(runtime.template.driverHints.modbus.writeThrottleMs, 250);
  assert.equal(runtime.template.driverHints.modbus.minCommandIntervalMs, 1000);
});

test('priority feedback updates exact power without 500 W quantisation', async () => {
  const runtime = makeRuntime(2733);
  await pollSungrowFeedbackOnce(runtime);
  assert.equal(runtime.states.get('devices.ess1.bATTERY_POWER'), 2733);
  assert.equal(runtime.states.get('devices.ess1.aliases.r.power'), 2733);
  assert.equal(runtime.states.get('devices.ess1.aliases.r.powerDischarge'), 2733);
});

test('zero remains zero and is never replaced by a fallback', async () => {
  const runtime = makeRuntime(0);
  await pollSungrowFeedbackOnce(runtime);
  assert.equal(runtime.states.get('devices.ess1.bATTERY_POWER'), 0);
  assert.equal(runtime.states.get('devices.ess1.aliases.r.power'), 0);
  assert.equal(runtime.states.get('devices.ess1.aliases.r.powerCharge'), 0);
  assert.equal(runtime.states.get('devices.ess1.aliases.r.powerDischarge'), 0);
});

test('negative charge feedback remains exact', async () => {
  const raw = (-731) & 0xffff;
  const runtime = makeRuntime(raw);
  await pollSungrowFeedbackOnce(runtime);
  assert.equal(runtime.states.get('devices.ess1.bATTERY_POWER'), -731);
  assert.equal(runtime.states.get('devices.ess1.aliases.r.powerCharge'), 731);
  assert.equal(runtime.states.get('devices.ess1.aliases.r.powerDischarge'), 0);
});
