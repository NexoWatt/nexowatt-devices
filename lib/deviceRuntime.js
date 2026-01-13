'use strict';

const path = require('path');
const { ModbusDriver } = require('./drivers/modbus');
const { MqttDriver } = require('./drivers/mqtt');
const { HttpDriver } = require('./drivers/http');
const { UdpDriver } = require('./drivers/udp');

class DeviceRuntime {
  constructor(adapter, deviceConfig, template, globalConfig) {
    this.adapter = adapter;
    this.cfg = deviceConfig;
    this.template = template;
    this.global = globalConfig || {};

    this.baseId = `devices.${this.cfg.id}`;
    this.dpByStateRelId = new Map(); // relId -> dpDef
    this.dpById = new Map(); // dpId -> dpDef

    // Alias states: stable datapoint names across different manufacturers/templates.
    // These are created under: devices.<id>.aliases.*
    this.aliasByStateRelId = new Map(); // relId -> aliasDef
    this.aliasDefs = []; // list of aliasDef

    this.driver = null;
    this.pollTimer = null;
    this.watchdogTimer = null;
    this.watchdogStartTimer = null;
    this._watchdogCounter = 0;
    this._watchdogBusy = false;
    this._connOk = false;
    this.started = false;
  }

  getDatapoints() {
    return (this.template && Array.isArray(this.template.datapoints)) ? this.template.datapoints : [];
  }

  relStateId(dp) {
    return `${this.baseId}.${dp.id}`;
  }

  async initObjects() {
    await this.adapter.setObjectNotExistsAsync(this.baseId, {
      type: 'channel',
      common: { name: this.cfg.name || this.cfg.id },
      native: {
        deviceId: this.cfg.id,
        templateId: this.cfg.templateId,
        category: this.cfg.category,
        manufacturer: this.cfg.manufacturer,
      }
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info`, {
      type: 'channel',
      common: { name: 'Info' },
      native: {}
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info.connection`, {
      type: 'state',
      common: {
        name: 'Connection',
        type: 'boolean',
        role: 'indicator.connected',
        read: true,
        write: false,
        def: false
      },
      native: {}
    });

    await this.adapter.setObjectNotExistsAsync(`${this.baseId}.info.lastError`, {
      type: 'state',
      common: {
        name: 'Last error',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: ''
      },
      native: {}
    });

    const dps = this.getDatapoints();
    for (const dp of dps) {
      const relId = this.relStateId(dp);

      const src = dp.source || {};
      const common = {
        name: dp.name || dp.id,
        type: dp.type || 'number',
        role: dp.role || 'value',
        read: dp.rw !== 'wo',
        write: dp.rw === 'rw' || dp.rw === 'wo',
      };

      if (src.kind === 'modbus') {
        common.unit = dp.unit || '';
      }

      await this.adapter.setObjectNotExistsAsync(relId, {
        type: 'state',
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          datapointId: dp.id,
          source: src,
        }
      });

      this.dpByStateRelId.set(relId, dp);
      this.dpById.set(dp.id, dp);
    }

    // Create stable alias states (optional per template/category).
    try {
      await this._initAliasObjects();
    } catch (e) {
      // Alias creation must never break device start.
      this.adapter.log.debug(`[${this.cfg.id}] alias init failed: ${e && e.message ? e.message : e}`);
    }
  }

  _getDpByRole(role) {
    const dps = this.getDatapoints();
    for (const dp of dps) {
      if (!dp || !dp.role) continue;
      if (dp.role === role) return dp;
    }
    return null;
  }

  _getDpById(id) {
    if (!id) return null;
    return this.dpById.get(id) || null;
  }

  _findFirstDatapoint(predicate) {
    const dps = this.getDatapoints();
    for (const dp of dps) {
      if (!dp) continue;
      try {
        if (predicate(dp)) return dp;
      } catch (e) {
        // ignore
      }
    }
    return null;
  }

  _aliasRelId(aliasPath) {
    // Always place aliases under: devices.<id>.aliases.<...>
    return `${this.baseId}.aliases.${aliasPath}`;
  }

  async _ensureChannel(relId, name) {
    await this.adapter.setObjectNotExistsAsync(relId, {
      type: 'channel',
      common: { name: name || relId.split('.').slice(-1)[0] },
      native: {
        deviceId: this.cfg.id,
        templateId: this.cfg.templateId,
        isAliasContainer: true,
      }
    });
  }

  async _ensureAliasPathChannels(stateRelId) {
    // Example: devices.<id>.aliases.ctrl.powerLimitPct
    // Create channels for: devices.<id>.aliases and devices.<id>.aliases.ctrl
    const parts = String(stateRelId).split('.');
    // Find index of "aliases" in the path
    const idx = parts.indexOf('aliases');
    if (idx < 0) return;

    const channels = [];
    // Build incremental channel ids up to the parent of the state
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (p === '') continue;
      const rel = parts.slice(0, i + 1).join('.');
      if (i >= idx) channels.push(rel);
    }

    // Ensure base aliases channel has a friendly name
    for (const ch of channels) {
      const chName = ch.endsWith('.aliases') ? 'Aliases' : ch.split('.').slice(-1)[0];
      await this._ensureChannel(ch, chName);
    }
  }

  _buildAliasDefinitions() {
    const defs = [];
    const relIds = new Set();
    const add = (def) => {
      if (!def || !def.relId) return;
      if (relIds.has(def.relId)) return;
      relIds.add(def.relId);
      defs.push(def);
    };

    const cat = (this.template && this.template.category) ? String(this.template.category) : '';
    const chargerCats = new Set(['EVCS', 'EVSE', 'CHARGER', 'DC_CHARGER']);

    const findByIdRe = (re) => this._findFirstDatapoint(dp => re.test(String(dp && dp.id ? dp.id : '')));
    const findByIdOrNameRe = (re) => this._findFirstDatapoint(dp =>
      re.test(String(dp && dp.id ? dp.id : '')) || re.test(String(dp && dp.name ? dp.name : ''))
    );

    const getAnyById = (...ids) => {
      for (const id of ids) {
        const dp = this._getDpById(id);
        if (dp) return dp;
      }
      return null;
    };

    // --- Always available (communication) ---
    add({
      relId: this._aliasRelId('comm.connected'),
      name: 'Device communication connected',
      role: 'indicator.connected',
      type: 'boolean',
      rw: 'ro',
      kind: 'computed',
      get: (_values, ctx) => !!(ctx && ctx.connected),
    });

    add({
      relId: this._aliasRelId('comm.lastError'),
      name: 'Device communication last error',
      role: 'text',
      type: 'string',
      rw: 'ro',
      kind: 'computed',
      get: (_values, ctx) => (ctx && typeof ctx.lastError === 'string') ? ctx.lastError : '',
    });

    add({
      relId: this._aliasRelId('alarm.offline'),
      name: 'Device offline',
      role: 'indicator.alarm',
      type: 'boolean',
      rw: 'ro',
      kind: 'computed',
      get: (_values, ctx) => !(ctx && ctx.connected),
    });

    // --- Generic role-based aliases (best-effort) ---
    // Only use these for categories where roles are typically reliable and where "first match wins" is acceptable.
    // For meters, chargers, batteries and ESS we create dedicated alias mapping further below.
    const allowGenericRoleAliases = !chargerCats.has(cat) && !['METER', 'BATTERY', 'ESS', 'BATTERY_INVERTER'].includes(cat);

    if (allowGenericRoleAliases) {
      const powerDp = getAnyById('W') || this._findFirstDatapoint(dp => dp.role === 'value.power' && dp.rw !== 'wo');
      if (powerDp) {
        add({
          relId: this._aliasRelId('r.power'),
          name: 'Active power',
          role: 'value.power',
          type: 'number',
          unit: powerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: powerDp.id,
        });
      }

      const energyDp = getAnyById('WH', 'TotWhOut') || this._findFirstDatapoint(dp => dp.role === 'value.energy' && dp.rw !== 'wo');
      if (energyDp) {
        add({
          relId: this._aliasRelId('r.energyTotal'),
          name: 'Total energy',
          role: 'value.energy',
          type: 'number',
          unit: energyDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: energyDp.id,
        });
      }

      const statusDp = getAnyById('Health', 'St') || this._findFirstDatapoint(dp => dp.role === 'indicator.status' && dp.rw !== 'wo');
      if (statusDp) {
        add({
          relId: this._aliasRelId('r.statusCode'),
          name: 'Status code',
          role: 'indicator.status',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: statusDp.id,
        });
      }
    }

    // --- PV inverter specific controls & alarms ---
    if (cat === 'PV_INVERTER') {
      // grid state (raw)
      const gridStateDp = getAnyById('PVConn', 'PvGriConn', 'GriSwStt');
      if (gridStateDp) {
        add({
          relId: this._aliasRelId('r.gridConnectionState'),
          name: 'Grid connection state (raw)',
          role: 'indicator',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: gridStateDp.id,
        });
      }

      // grid connected (boolean) - computed from known SMA codes where possible
      add({
        relId: this._aliasRelId('r.gridConnected'),
        name: 'Grid connected',
        role: 'indicator.connected',
        type: 'boolean',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          if (!values) return undefined;
          if (typeof values.PvGriConn === 'number') return values.PvGriConn === 1780;
          if (typeof values.GriSwStt === 'number') return values.GriSwStt === 51;
          if (typeof values.PVConn === 'number') return values.PVConn !== 0;
          return undefined;
        }
      });

      // power limit percent setpoint
      const limitPctDp = getAnyById('WMaxLimPct', 'WLimPct') || this._findFirstDatapoint(dp =>
        (dp.unit === '%' || dp.unit === ' %' || dp.unit === '% ') &&
        (dp.rw === 'rw' || dp.rw === 'wo') &&
        /lim/i.test(String(dp.id))
      );
      if (limitPctDp) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitPct'),
          name: 'Active power limit (%)',
          role: 'level',
          type: 'number',
          unit: '%',
          // Expose as read+write even if the underlying register is write-only.
          // In that case we keep the last commanded value until the device provides a readable feedback register.
          rw: 'rw',
          kind: 'dp',
          dpId: limitPctDp.id,
          // allow writes through the alias even if the underlying datapoint is write-only
          writeDpId: limitPctDp.id,
        });
      }

      // power limit enable
      const limitEnaDp = getAnyById('WMaxLim_Ena') || this._findFirstDatapoint(dp =>
        (dp.type === 'boolean') &&
        (dp.rw === 'rw') &&
        /lim/i.test(String(dp.id)) &&
        /ena/i.test(String(dp.id))
      );
      if (limitEnaDp) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitEnable'),
          name: 'Active power limit enable',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: limitEnaDp.id,
          writeDpId: limitEnaDp.id,
        });
      }

      // run/stop command
      // Preference order:
      //  1) boolean "Conn" (true/false)
      //  2) "FstStop" (fast shut-down command, often Start=1467 / Stop=381)
      //  3) "OpMod" (operating mode codes)
      const connDp = getAnyById('Conn');
      const fstStopDp = getAnyById('FstStop');
      const opModDp = getAnyById('OpMod');
      if (connDp && (connDp.rw === 'rw' || connDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.run'),
          name: 'Run (connect/start)',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: connDp.id,
          writeDpId: connDp.id,
          toDevice: (v) => !!v,
          fromDevice: (v) => !!v,
        });
      } else if (fstStopDp && (fstStopDp.rw === 'rw' || fstStopDp.rw === 'wo')) {
        // Some SMA devices expose a "Fast shut-down" command that doubles as start/stop control.
        // Typical codes:
        //  - 1467: Start
        //  - 381 : Stop
        //  - 1749: Full stop
        add({
          relId: this._aliasRelId('ctrl.run'),
          name: 'Run (start/stop)',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: fstStopDp.id,
          writeDpId: fstStopDp.id,
          toDevice: (v) => (v ? 1467 : 381),
          fromDevice: (v) => {
            if (v === 1467) return true;
            if (v === 381 || v === 1749) return false;
            return undefined;
          }
        });
      } else if (opModDp && (opModDp.rw === 'rw' || opModDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.run'),
          name: 'Run (start/stop)',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: opModDp.id,
          writeDpId: opModDp.id,
          toDevice: (v) => (v ? 1467 : 381),
          fromDevice: (v) => {
            if (v === 1467) return true;
            if (v === 381) return false;
            return undefined;
          }
        });
      }

      // alarm.fault / alarm.warning (best-effort)
      add({
        relId: this._aliasRelId('alarm.fault'),
        name: 'Fault active',
        role: 'indicator.alarm',
        type: 'boolean',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          // Offline should not automatically equal "fault"; keep separate.
          if (!values) return false;
          let fault = false;
          if (typeof values.Health === 'number') fault = fault || (values.Health === 35);
          if (typeof values.St === 'number') fault = fault || (values.St === 7);
          if (typeof values.Evt1 === 'number') fault = fault || (values.Evt1 !== 0);
          return fault;
        }
      });

      add({
        relId: this._aliasRelId('alarm.warning'),
        name: 'Warning active',
        role: 'indicator.alarm',
        type: 'boolean',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          if (!values) return false;
          if (typeof values.Health === 'number') return values.Health === 455;
          return false;
        }
      });
    }

    // --- Battery / ESS aliases (BATTERY, ESS, BATTERY_INVERTER) ---
    // These categories often use vendor-specific datapoint IDs and generic ioBroker roles are not reliable.
    // We therefore derive a stable alias API primarily from datapoint IDs (best-effort).
    const batteryCats = new Set(['BATTERY', 'ESS', 'BATTERY_INVERTER']);
    if (batteryCats.has(cat)) {
      const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;
      const asBool01 = (v) => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        return undefined;
      };

      // --- Core read signals ---
      const socDp =
        getAnyById('sOC', 'bATTERY_SOC', 'bATTERY_TOTAL_SOC') ||
        findByIdRe(/(^|_)soc($|_)/i) ||
        this._findFirstDatapoint(dp => /soc/i.test(String(dp.id || '')));

      if (socDp) {
        add({
          relId: this._aliasRelId('r.soc'),
          name: 'State of charge',
          role: 'value.battery',
          type: 'number',
          unit: socDp.unit || '%',
          rw: 'ro',
          kind: 'dp',
          dpId: socDp.id,
        });
      }

      const sohDp =
        getAnyById('sOH') ||
        findByIdRe(/(^|_)soh($|_)/i) ||
        this._findFirstDatapoint(dp => /soh/i.test(String(dp.id || '')));

      if (sohDp) {
        add({
          relId: this._aliasRelId('r.soh'),
          name: 'State of health',
          role: 'value',
          type: 'number',
          unit: sohDp.unit || '%',
          rw: 'ro',
          kind: 'dp',
          dpId: sohDp.id,
        });
      }

      const battVoltDp =
        getAnyById('bATTERY_VOLTAGE', 'dC_BATTERY_VOLTAGE', 'vOLTAGE', 'lINK_VOLTAGE', 'iNTERNAL_VOLTAGE') ||
        this._findFirstDatapoint(dp => /battery_.*voltage/i.test(String(dp.id || ''))) ||
        this._findFirstDatapoint(dp => /voltage/i.test(String(dp.id || '')) && !/grid_/i.test(String(dp.id || '')));

      if (battVoltDp) {
        add({
          relId: this._aliasRelId('r.voltage'),
          name: 'Battery voltage',
          role: 'value.voltage',
          type: 'number',
          unit: battVoltDp.unit || 'V',
          rw: 'ro',
          kind: 'dp',
          dpId: battVoltDp.id,
        });
      }

      const battCurrDp =
        getAnyById('bATTERY_CURRENT', 'dC_BATTERY_CURRENT', 'cURRENT') ||
        this._findFirstDatapoint(dp => /battery_.*current/i.test(String(dp.id || ''))) ||
        this._findFirstDatapoint(dp => /current/i.test(String(dp.id || '')) && !/input_/i.test(String(dp.id || '')) && !/output_/i.test(String(dp.id || '')));

      if (battCurrDp) {
        add({
          relId: this._aliasRelId('r.current'),
          name: 'Battery current',
          role: 'value.current',
          type: 'number',
          unit: battCurrDp.unit || 'A',
          rw: 'ro',
          kind: 'dp',
          dpId: battCurrDp.id,
        });
      }

      const battTempDp =
        getAnyById('bATTERY_TEMPERATURE', 'aVG_BATTERY_TEMPERATURE') ||
        this._findFirstDatapoint(dp => /^bATTERY_.*tEMPERATURE$/i.test(String(dp.id || ''))) ||
        this._findFirstDatapoint(dp => /battery_.*temperature/i.test(String(dp.id || '')));

      if (battTempDp) {
        add({
          relId: this._aliasRelId('r.temperature'),
          name: 'Battery temperature',
          role: 'value.temperature',
          type: 'number',
          unit: battTempDp.unit || '°C',
          rw: 'ro',
          kind: 'dp',
          dpId: battTempDp.id,
        });
      }

      // --- Power (W): prefer measured DC battery power, else AC active power, else compute from V*I ---
      const activePowerDp =
        getAnyById('bATTERY_POWER', 'aCTIVE_POWER') ||
        this._findFirstDatapoint(dp => /^bATTERY_.*pOWER$/i.test(String(dp.id || '')) && dp.rw !== 'wo') ||
        this._findFirstDatapoint(dp => /^aCTIVE_POWER$/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      // Some SMA batteries provide separate charge/discharge currents (unsigned). Use these when present.
      const chargeCurrentDp = getAnyById('cUR_BAT_CHA');
      const dischargeCurrentDp = getAnyById('cUR_BAT_DSCH');

      // Per-phase active power (common in ESS/battery inverter)
      const pL1 = getAnyById('aCTIVE_POWER_L1');
      const pL2 = getAnyById('aCTIVE_POWER_L2');
      const pL3 = getAnyById('aCTIVE_POWER_L3');

      const computeBatteryPowerW = (values) => {
        if (!values) return undefined;

        // Prefer explicit measured power datapoint
        if (activePowerDp) {
          const v = asNumber(values[activePowerDp.id]);
          if (v !== undefined) return v;
        }

        // Sum per-phase active powers if present
        const v1 = pL1 ? asNumber(values[pL1.id]) : undefined;
        const v2 = pL2 ? asNumber(values[pL2.id]) : undefined;
        const v3 = pL3 ? asNumber(values[pL3.id]) : undefined;
        if (v1 !== undefined || v2 !== undefined || v3 !== undefined) return (v1 || 0) + (v2 || 0) + (v3 || 0);

        // If we have separate charge/discharge currents and a battery voltage, compute net power.
        if (battVoltDp && (chargeCurrentDp || dischargeCurrentDp)) {
          const u = asNumber(values[battVoltDp.id]);
          const icha = chargeCurrentDp ? asNumber(values[chargeCurrentDp.id]) : undefined;
          const idsch = dischargeCurrentDp ? asNumber(values[dischargeCurrentDp.id]) : undefined;
          if (u !== undefined && (icha !== undefined || idsch !== undefined)) {
            const pCharge = (icha || 0) * u;
            const pDischarge = (idsch || 0) * u;
            // Convention: discharge positive, charge negative
            return pDischarge - pCharge;
          }
        }

        // Fallback: compute from signed battery current * voltage
        if (battVoltDp && battCurrDp) {
          const u = asNumber(values[battVoltDp.id]);
          const i = asNumber(values[battCurrDp.id]);
          if (u !== undefined && i !== undefined) return u * i;
        }

        return undefined;
      };

      add({
        relId: this._aliasRelId('r.power'),
        name: 'Battery power (net)',
        role: 'value.power',
        type: 'number',
        unit: 'W',
        rw: 'ro',
        kind: 'computed',
        get: (values) => computeBatteryPowerW(values),
      });

      // Split into charge/discharge power (absolute)
      add({
        relId: this._aliasRelId('r.powerCharge'),
        name: 'Battery charge power',
        role: 'value.power',
        type: 'number',
        unit: 'W',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          const p = computeBatteryPowerW(values);
          if (p === undefined) return undefined;
          return p < 0 ? Math.abs(p) : 0;
        }
      });

      add({
        relId: this._aliasRelId('r.powerDischarge'),
        name: 'Battery discharge power',
        role: 'value.power',
        type: 'number',
        unit: 'W',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          const p = computeBatteryPowerW(values);
          if (p === undefined) return undefined;
          return p > 0 ? p : 0;
        }
      });

      // --- PV power (for hybrid inverters) ---
      const pvPowerDp =
        getAnyById('pV_POWER', 'pV_POWER_SUM') ||
        this._findFirstDatapoint(dp => /^pV_.*pOWER/i.test(String(dp.id || '')) && dp.rw !== 'wo') ||
        this._findFirstDatapoint(dp => /pv.*power/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      if (pvPowerDp) {
        add({
          relId: this._aliasRelId('r.pvPower'),
          name: 'PV power',
          role: 'value.power',
          type: 'number',
          unit: pvPowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: pvPowerDp.id,
        });
      }

      // --- Energy counters (Wh) ---
      const chargeEnergyDp =
        getAnyById('aCTIVE_CHARGE_ENERGY', 'dC_CHARGED_ENERGY', 'dC_CHARGE_ENERGY', 'aCT_BAT_CHRG') ||
        this._findFirstDatapoint(dp => /charge.*energy/i.test(String(dp.id || '')) && !/parameter/i.test(String(dp.id || '')));

      const dischargeEnergyDp =
        getAnyById('aCTIVE_DISCHARGE_ENERGY', 'dC_DISCHARGED_ENERGY', 'dC_DISCHARGE_ENERGY', 'aCT_BAT_DSCH') ||
        this._findFirstDatapoint(dp => /discharge.*energy/i.test(String(dp.id || '')) && !/parameter/i.test(String(dp.id || '')));

      const safeU64ToNumber = (raw) => {
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string') {
          const n = Number(raw);
          if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
        }
        return undefined;
      };

      if (chargeEnergyDp) {
        add({
          relId: this._aliasRelId('r.energyCharge'),
          name: 'Charge energy (total)',
          role: 'value.energy',
          type: 'number',
          unit: chargeEnergyDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: chargeEnergyDp.id,
          fromDevice: (v) => safeU64ToNumber(v),
        });
      }

      if (dischargeEnergyDp) {
        add({
          relId: this._aliasRelId('r.energyDischarge'),
          name: 'Discharge energy (total)',
          role: 'value.energy',
          type: 'number',
          unit: dischargeEnergyDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: dischargeEnergyDp.id,
          fromDevice: (v) => safeU64ToNumber(v),
        });
      }

      // --- BMS allow charge/discharge (read) ---
      const allowChargeDp = getAnyById('bP_CHARGE_BMS', 'vE_BUS_BMS_ALLOW_BATTERY_CHARGE');
      if (allowChargeDp) {
        add({
          relId: this._aliasRelId('r.allowCharge'),
          name: 'BMS allows charge',
          role: 'indicator',
          type: 'boolean',
          rw: 'ro',
          kind: 'dp',
          dpId: allowChargeDp.id,
          fromDevice: (v) => asBool01(v),
        });
      }

      const allowDischargeDp = getAnyById('bP_DISCHARGE_BMS', 'vE_BUS_BMS_ALLOW_BATTERY_DISCHARGE');
      if (allowDischargeDp) {
        add({
          relId: this._aliasRelId('r.allowDischarge'),
          name: 'BMS allows discharge',
          role: 'indicator',
          type: 'boolean',
          rw: 'ro',
          kind: 'dp',
          dpId: allowDischargeDp.id,
          fromDevice: (v) => asBool01(v),
        });
      }

      // --- Allowed charge/discharge power (W) ---
      const allowedChargePowerDp = getAnyById('aLLOWED_CHARGE_POWER', 'oRIGINAL_ALLOWED_CHARGE_POWER');
      if (allowedChargePowerDp) {
        add({
          relId: this._aliasRelId('r.allowedChargePower'),
          name: 'Allowed charge power',
          role: 'value.power',
          type: 'number',
          unit: allowedChargePowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: allowedChargePowerDp.id,
        });
      }

      const allowedDischargePowerDp = getAnyById('aLLOWED_DISCHARGE_POWER', 'oRIGINAL_ALLOWED_DISCHARGE_POWER', 'eSS_MAX_DISCHARGE_POWER');
      if (allowedDischargePowerDp) {
        add({
          relId: this._aliasRelId('r.allowedDischargePower'),
          name: 'Allowed discharge power',
          role: 'value.power',
          type: 'number',
          unit: allowedDischargePowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: allowedDischargePowerDp.id,
        });
      }

      // --- Control: active power setpoint (W) ---
      const setActivePowerDp =
        getAnyById('sET_ACTIVE_POWER') ||
        this._findFirstDatapoint(dp => /^sET_ACTIVE_POWER$/i.test(String(dp.id || '')) && (dp.rw === 'rw' || dp.rw === 'wo')) ||
        this._findFirstDatapoint(dp => /^sET_ACTIVE_POWER(_6_\d+)?$/i.test(String(dp.id || '')) && (dp.rw === 'rw' || dp.rw === 'wo'));

      if (setActivePowerDp) {
        add({
          relId: this._aliasRelId('ctrl.powerSetpointW'),
          name: 'Active power setpoint (battery/ESS)',
          role: 'level.power',
          type: 'number',
          unit: setActivePowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: setActivePowerDp.id,
          writeDpId: setActivePowerDp.id,
        });

        // Convenience aliases: split-direction power setpoints.
        // Standard: charge power is written as positive value and mapped to a NEGATIVE setpoint,
        // discharge power is written as positive value and mapped to a POSITIVE setpoint.
        // This is especially useful for devices like SolaX where one register controls both directions.
        add({
          relId: this._aliasRelId('ctrl.chargePowerW'),
          name: 'Charge power setpoint',
          role: 'level.power',
          type: 'number',
          unit: setActivePowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: setActivePowerDp.id,
          writeDpId: setActivePowerDp.id,
          toDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return -Math.abs(n);
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return undefined;
            return n < 0 ? Math.abs(n) : 0;
          }
        });

        add({
          relId: this._aliasRelId('ctrl.dischargePowerW'),
          name: 'Discharge power setpoint',
          role: 'level.power',
          type: 'number',
          unit: setActivePowerDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: setActivePowerDp.id,
          writeDpId: setActivePowerDp.id,
          toDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return Math.abs(n);
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return undefined;
            return n > 0 ? Math.abs(n) : 0;
          }
        });
      }

      // Per-phase setpoints (if available)
      const setPL1 = getAnyById('sET_ACTIVE_POWER_L1');
      const setPL2 = getAnyById('sET_ACTIVE_POWER_L2');
      const setPL3 = getAnyById('sET_ACTIVE_POWER_L3');
      if (setPL1 && (setPL1.rw === 'rw' || setPL1.rw === 'wo')) add({ relId: this._aliasRelId('ctrl.powerSetpointL1'), name: 'Active power setpoint L1', role: 'level.power', type: 'number', unit: setPL1.unit || 'W', rw: 'rw', kind: 'dp', dpId: setPL1.id, writeDpId: setPL1.id });
      if (setPL2 && (setPL2.rw === 'rw' || setPL2.rw === 'wo')) add({ relId: this._aliasRelId('ctrl.powerSetpointL2'), name: 'Active power setpoint L2', role: 'level.power', type: 'number', unit: setPL2.unit || 'W', rw: 'rw', kind: 'dp', dpId: setPL2.id, writeDpId: setPL2.id });
      if (setPL3 && (setPL3.rw === 'rw' || setPL3.rw === 'wo')) add({ relId: this._aliasRelId('ctrl.powerSetpointL3'), name: 'Active power setpoint L3', role: 'level.power', type: 'number', unit: setPL3.unit || 'W', rw: 'rw', kind: 'dp', dpId: setPL3.id, writeDpId: setPL3.id });

      // Control: control mode (vendor-specific but stable location)
      const controlModeDp = getAnyById('sET_CONTROL_MODE');
      if (controlModeDp && (controlModeDp.rw === 'rw' || controlModeDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.controlMode'),
          name: 'Control mode',
          role: 'level',
          type: 'number',
          rw: 'rw',
          kind: 'dp',
          dpId: controlModeDp.id,
          writeDpId: controlModeDp.id,
        });
      }


      // --- Grid / NAP power & setpoints (Energy Managers / Hybrid systems) ---
      // Some systems (e.g., TESVOLT Energy Manager Vermarkter-Schnittstelle) expose the grid connection point as "NAP".
      // We provide a stable read alias for the current grid/NAP power and a stable write alias for the grid/NAP setpoint.
      const gridPowerDp =
        getAnyById('gRID_POWER', 'nAP_POWER') ||
        this._findFirstDatapoint(dp => /(^|_)(grid|nap).*power/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      if (gridPowerDp) {
        add({
          relId: this._aliasRelId('r.gridPower'),
          name: 'Grid / NAP power',
          role: 'value.power',
          type: 'number',
          unit: gridPowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: gridPowerDp.id,
        });
      }

      const gridSetpointDp =
        getAnyById('nAP_POWER_SETPOINT', 'sET_NAP_POWER', 'gRID_POWER_SETPOINT') ||
        this._findFirstDatapoint(dp =>
          (dp.rw === 'rw' || dp.rw === 'wo') &&
          /(nap|grid).*(set|target|limit).*power/i.test(String(dp.id || ''))
        );

      if (gridSetpointDp) {
        add({
          relId: this._aliasRelId('ctrl.gridSetpointW'),
          name: 'Grid / NAP power setpoint',
          role: 'level.power',
          type: 'number',
          unit: gridSetpointDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: gridSetpointDp.id,
          writeDpId: gridSetpointDp.id,
        });

        // Synonym (more explicit)
        add({
          relId: this._aliasRelId('ctrl.napSetpointW'),
          name: 'NAP power setpoint',
          role: 'level.power',
          type: 'number',
          unit: gridSetpointDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: gridSetpointDp.id,
          writeDpId: gridSetpointDp.id,
        });
      }



      // --- PV / export power limiting (best-effort) ---
      const exportPowerPctDp = getAnyById('eXPORT_POWER_PERCENTAGE', 'wMaxLimPct', 'wMAXLIMPCT');
      if (exportPowerPctDp && (exportPowerPctDp.rw === 'rw' || exportPowerPctDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitPct'),
          name: 'PV/export power limit (%)',
          role: 'level',
          type: 'number',
          unit: exportPowerPctDp.unit || '%',
          rw: 'rw',
          kind: 'dp',
          dpId: exportPowerPctDp.id,
          writeDpId: exportPowerPctDp.id,
        });

        // More explicit synonym (useful when multiple device categories are merged downstream)
        add({
          relId: this._aliasRelId('ctrl.exportLimitPct'),
          name: 'Export power limit (%)',
          role: 'level',
          type: 'number',
          unit: exportPowerPctDp.unit || '%',
          rw: 'rw',
          kind: 'dp',
          dpId: exportPowerPctDp.id,
          writeDpId: exportPowerPctDp.id,
        });
      }

      const exportPowerLimitDp = getAnyById('eXPORT_POWER_LIMIT', 'wMaxLim', 'wMAXLIM');
      if (exportPowerLimitDp && (exportPowerLimitDp.rw === 'rw' || exportPowerLimitDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitW'),
          name: 'PV/export power limit (W)',
          role: 'level.power',
          type: 'number',
          unit: exportPowerLimitDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: exportPowerLimitDp.id,
          writeDpId: exportPowerLimitDp.id,
        });

        add({
          relId: this._aliasRelId('ctrl.exportLimitW'),
          name: 'Export power limit (W)',
          role: 'level.power',
          type: 'number',
          unit: exportPowerLimitDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: exportPowerLimitDp.id,
          writeDpId: exportPowerLimitDp.id,
        });
      }

      // Control: charge enable (best-effort)
      const disableChargeDp = getAnyById('eSS_DISABLE_CHARGE_FLAG');
      if (disableChargeDp && (disableChargeDp.rw === 'rw' || disableChargeDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.chargeEnable'),
          name: 'Charge enable',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: disableChargeDp.id,
          writeDpId: disableChargeDp.id,
          toDevice: (v) => (v ? 0 : 1),
          fromDevice: (v) => {
            const b = asBool01(v);
            if (b === undefined) return undefined;
            // dp is DISABLE flag -> invert
            return !b;
          }
        });
      }

      // --- Status & alarms (best-effort, conservative) ---
      const statusDp =
        getAnyById('bAT_STATUS', 'bATTERY_STATE', 'bATTERY_WORK_STATE', 'sYSTEM_STATE', 'cLUSTER_RUN_STATE', 'sYSTEM_RUNNING_STATE', 'vE_BUS_STATE', 'sWITCH_POSITION') ||
        this._findFirstDatapoint(dp => /(^|_)(state|status|health)($|_)/i.test(String(dp.id || '')) && !/parameter/i.test(String(dp.id || '')));

      if (statusDp) {
        add({
          relId: this._aliasRelId('r.statusCode'),
          name: 'Status code',
          role: 'indicator.status',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: statusDp.id,
        });
      }

      const errorCodeDp =
        getAnyById('vE_BUS_ERROR', 'vE_BUS_BMS_ERROR', 'iNSULATION_RESISTANCE_ERROR_LEVEL') ||
        this._findFirstDatapoint(dp => /(^|_)(error|fault)($|_)/i.test(String(dp.id || '')) && !/parameter/i.test(String(dp.id || '')));

      if (errorCodeDp) {
        add({
          relId: this._aliasRelId('r.errorCode'),
          name: 'Error code',
          role: 'indicator',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: errorCodeDp.id,
        });
      }

      // Conservative fault detection: explicit error codes or active alarm/protect flag registers (non-zero)
      const faultFlagDps = this.getDatapoints().filter(dp => {
        const id = String(dp && dp.id ? dp.id : '');
        if (!id) return false;
        // exclude configuration thresholds
        if (/(parameter|limit|recover|threshold)/i.test(id)) return false;
        return /(vE_BUS_ERROR|vE_BUS_BMS_ERROR|ALARM_FLAG_REGISTER|PROTECT_FLAG_REGISTER|SYSTEM_FAULT_COUNTERS|INSULATION_RESISTANCE_ERROR_LEVEL)/i.test(id);
      });

      add({
        relId: this._aliasRelId('alarm.fault'),
        name: 'Fault active',
        role: 'indicator.alarm',
        type: 'boolean',
        rw: 'ro',
        kind: 'computed',
        get: (values) => {
          if (!values) return false;
          // explicit error code
          if (errorCodeDp) {
            const v = values[errorCodeDp.id];
            if (typeof v === 'number') return v !== 0;
          }

          for (const dp of faultFlagDps) {
            const v = values[dp.id];
            if (typeof v === 'boolean' && v) return true;
            if (typeof v === 'number' && v !== 0) return true;
          }
          return false;
        }
      });

      // Warning (best-effort): look for active warning registers (exclude parameters)
      const warnFlagDps = this.getDatapoints().filter(dp => {
        const id = String(dp && dp.id ? dp.id : '');
        if (!id) return false;
        if (/(parameter|limit|recover|threshold)/i.test(id)) return false;
        return /(warning|warn)/i.test(id);
      });

      if (warnFlagDps && warnFlagDps.length) {
        add({
          relId: this._aliasRelId('alarm.warning'),
          name: 'Warning active',
          role: 'indicator.alarm',
          type: 'boolean',
          rw: 'ro',
          kind: 'computed',
          get: (values) => {
            if (!values) return false;
            for (const dp of warnFlagDps) {
              const v = values[dp.id];
              if (typeof v === 'boolean' && v) return true;
              if (typeof v === 'number' && v !== 0) return true;
            }
            return false;
          }
        });
      }
    }

    // --- Meter aliases (read-only, stable API) ---
    if (cat === 'METER') {
      // Identify datapoints (best-effort)
      const netPowerDp =
        getAnyById('aCTIVE_POWER') ||
        findByIdRe(/^aCTIVE_POWER$/i);

      const importPowerDp =
        getAnyById('aCTIVE_CONSUMPTION_POWER') ||
        findByIdRe(/^aCTIVE_CONSUMPTION_POWER(?!_L[123])/i);

      const exportPowerDp =
        getAnyById('aCTIVE_PRODUCTION_POWER') ||
        findByIdRe(/^aCTIVE_PRODUCTION_POWER(?!_L[123])/i);

      const posPowerDp =
        getAnyById('aCTIVE_POWER_POS') ||
        findByIdRe(/^aCTIVE_POWER_POS$/i);

      const negPowerDp =
        getAnyById('aCTIVE_POWER_NEG') ||
        findByIdRe(/^aCTIVE_POWER_NEG$/i);

      const pL1 = getAnyById('aCTIVE_POWER_L1');
      const pL2 = getAnyById('aCTIVE_POWER_L2');
      const pL3 = getAnyById('aCTIVE_POWER_L3');

      const importEnergyDp =
        getAnyById('aCTIVE_CONSUMPTION_ENERGY') ||
        findByIdRe(/^aCTIVE_CONSUMPTION_ENERGY(?!_L[123])/i);

      const exportEnergyDp =
        getAnyById('aCTIVE_PRODUCTION_ENERGY') ||
        findByIdRe(/^aCTIVE_PRODUCTION_ENERGY(?!_L[123])/i);

      const importEnergyL1 = findByIdRe(/^aCTIVE_CONSUMPTION_ENERGY_L1/i) || getAnyById('aCTIVE_CONSUMPTION_ENERGY_L1');
      const importEnergyL2 = findByIdRe(/^aCTIVE_CONSUMPTION_ENERGY_L2/i) || getAnyById('aCTIVE_CONSUMPTION_ENERGY_L2');
      const importEnergyL3 = findByIdRe(/^aCTIVE_CONSUMPTION_ENERGY_L3/i) || getAnyById('aCTIVE_CONSUMPTION_ENERGY_L3');

      const exportEnergyL1 = findByIdRe(/^aCTIVE_PRODUCTION_ENERGY_L1/i) || getAnyById('aCTIVE_PRODUCTION_ENERGY_L1');
      const exportEnergyL2 = findByIdRe(/^aCTIVE_PRODUCTION_ENERGY_L2/i) || getAnyById('aCTIVE_PRODUCTION_ENERGY_L2');
      const exportEnergyL3 = findByIdRe(/^aCTIVE_PRODUCTION_ENERGY_L3/i) || getAnyById('aCTIVE_PRODUCTION_ENERGY_L3');

      const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;

      const computeNetPower = (values) => {
        if (!values) return undefined;

        const pNet = netPowerDp ? asNumber(values[netPowerDp.id]) : undefined;
        if (pNet !== undefined) return pNet;

        const imp = importPowerDp ? asNumber(values[importPowerDp.id]) : undefined;
        const exp = exportPowerDp ? asNumber(values[exportPowerDp.id]) : undefined;
        if (imp !== undefined || exp !== undefined) return (imp || 0) - (exp || 0);

        const pos = posPowerDp ? asNumber(values[posPowerDp.id]) : undefined;
        const neg = negPowerDp ? asNumber(values[negPowerDp.id]) : undefined;
        if (pos !== undefined || neg !== undefined) return (pos || 0) - (neg || 0);

        const p1 = pL1 ? asNumber(values[pL1.id]) : undefined;
        const p2 = pL2 ? asNumber(values[pL2.id]) : undefined;
        const p3 = pL3 ? asNumber(values[pL3.id]) : undefined;
        if (p1 !== undefined || p2 !== undefined || p3 !== undefined) return (p1 || 0) + (p2 || 0) + (p3 || 0);

        return undefined;
      };

      const computeImportPower = (values) => {
        if (!values) return undefined;

        const imp = importPowerDp ? asNumber(values[importPowerDp.id]) : undefined;
        if (imp !== undefined) return imp;

        const pos = posPowerDp ? asNumber(values[posPowerDp.id]) : undefined;
        if (pos !== undefined) return pos;

        const net = computeNetPower(values);
        if (net === undefined) return undefined;
        return net > 0 ? net : 0;
      };

      const computeExportPower = (values) => {
        if (!values) return undefined;

        const exp = exportPowerDp ? asNumber(values[exportPowerDp.id]) : undefined;
        if (exp !== undefined) return exp;

        const neg = negPowerDp ? asNumber(values[negPowerDp.id]) : undefined;
        if (neg !== undefined) return neg;

        const net = computeNetPower(values);
        if (net === undefined) return undefined;
        return net < 0 ? Math.abs(net) : 0;
      };

      const computeImportEnergy = (values) => {
        if (!values) return undefined;
        const e = importEnergyDp ? asNumber(values[importEnergyDp.id]) : undefined;
        if (e !== undefined) return e;

        const e1 = importEnergyL1 ? asNumber(values[importEnergyL1.id]) : undefined;
        const e2 = importEnergyL2 ? asNumber(values[importEnergyL2.id]) : undefined;
        const e3 = importEnergyL3 ? asNumber(values[importEnergyL3.id]) : undefined;
        if (e1 !== undefined || e2 !== undefined || e3 !== undefined) return (e1 || 0) + (e2 || 0) + (e3 || 0);

        return undefined;
      };

      const computeExportEnergy = (values) => {
        if (!values) return undefined;
        const e = exportEnergyDp ? asNumber(values[exportEnergyDp.id]) : undefined;
        if (e !== undefined) return e;

        const e1 = exportEnergyL1 ? asNumber(values[exportEnergyL1.id]) : undefined;
        const e2 = exportEnergyL2 ? asNumber(values[exportEnergyL2.id]) : undefined;
        const e3 = exportEnergyL3 ? asNumber(values[exportEnergyL3.id]) : undefined;
        if (e1 !== undefined || e2 !== undefined || e3 !== undefined) return (e1 || 0) + (e2 || 0) + (e3 || 0);

        return undefined;
      };

      const hasAnyPower = !!(netPowerDp || importPowerDp || exportPowerDp || posPowerDp || negPowerDp || pL1 || pL2 || pL3);

      // net power (W) - prefer direct active power, else compute from available signals
      if (hasAnyPower) {
        if (netPowerDp) {
          add({
            relId: this._aliasRelId('r.power'),
            name: 'Net active power',
            role: 'value.power',
            type: 'number',
            unit: netPowerDp.unit || 'W',
            rw: 'ro',
            kind: 'dp',
            dpId: netPowerDp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.power'),
            name: 'Net active power',
            role: 'value.power',
            type: 'number',
            unit: 'W',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeNetPower(values),
          });
        }

        // powerImport (W)
        if (importPowerDp || posPowerDp) {
          const dp = importPowerDp || posPowerDp;
          add({
            relId: this._aliasRelId('r.powerImport'),
            name: 'Import power',
            role: 'value.power',
            type: 'number',
            unit: dp.unit || 'W',
            rw: 'ro',
            kind: 'dp',
            dpId: dp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.powerImport'),
            name: 'Import power',
            role: 'value.power',
            type: 'number',
            unit: 'W',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeImportPower(values),
          });
        }

        // powerExport (W)
        if (exportPowerDp || negPowerDp) {
          const dp = exportPowerDp || negPowerDp;
          add({
            relId: this._aliasRelId('r.powerExport'),
            name: 'Export power',
            role: 'value.power',
            type: 'number',
            unit: dp.unit || 'W',
            rw: 'ro',
            kind: 'dp',
            dpId: dp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.powerExport'),
            name: 'Export power',
            role: 'value.power',
            type: 'number',
            unit: 'W',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeExportPower(values),
          });
        }
      }

      // energy import/export (Wh) - use totals when available, else sum per phase
      const hasAnyEnergy = !!(importEnergyDp || exportEnergyDp || importEnergyL1 || importEnergyL2 || importEnergyL3 || exportEnergyL1 || exportEnergyL2 || exportEnergyL3);

      if (hasAnyEnergy) {
        if (importEnergyDp) {
          add({
            relId: this._aliasRelId('r.energyImport'),
            name: 'Import energy',
            role: 'value.energy',
            type: 'number',
            unit: importEnergyDp.unit || 'Wh',
            rw: 'ro',
            kind: 'dp',
            dpId: importEnergyDp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.energyImport'),
            name: 'Import energy',
            role: 'value.energy',
            type: 'number',
            unit: 'Wh',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeImportEnergy(values),
          });
        }

        if (exportEnergyDp) {
          add({
            relId: this._aliasRelId('r.energyExport'),
            name: 'Export energy',
            role: 'value.energy',
            type: 'number',
            unit: exportEnergyDp.unit || 'Wh',
            rw: 'ro',
            kind: 'dp',
            dpId: exportEnergyDp.id,
          });
        } else {
          add({
            relId: this._aliasRelId('r.energyExport'),
            name: 'Export energy',
            role: 'value.energy',
            type: 'number',
            unit: 'Wh',
            rw: 'ro',
            kind: 'computed',
            get: (values) => computeExportEnergy(values),
          });
        }
      }

      // Phase voltages/currents (V/A) and frequency (Hz)
      const vL1 = getAnyById('vOLTAGE_L1') || getAnyById('vOLTAGE');
      const vL2 = getAnyById('vOLTAGE_L2');
      const vL3 = getAnyById('vOLTAGE_L3');

      const cL1 = getAnyById('cURRENT_L1') || getAnyById('cURRENT');
      const cL2 = getAnyById('cURRENT_L2');
      const cL3 = getAnyById('cURRENT_L3');

      if (vL1) add({ relId: this._aliasRelId('r.voltageL1'), name: 'Voltage L1', role: 'value.voltage', type: 'number', unit: vL1.unit || 'V', rw: 'ro', kind: 'dp', dpId: vL1.id });
      if (vL2) add({ relId: this._aliasRelId('r.voltageL2'), name: 'Voltage L2', role: 'value.voltage', type: 'number', unit: vL2.unit || 'V', rw: 'ro', kind: 'dp', dpId: vL2.id });
      if (vL3) add({ relId: this._aliasRelId('r.voltageL3'), name: 'Voltage L3', role: 'value.voltage', type: 'number', unit: vL3.unit || 'V', rw: 'ro', kind: 'dp', dpId: vL3.id });

      if (cL1) add({ relId: this._aliasRelId('r.currentL1'), name: 'Current L1', role: 'value.current', type: 'number', unit: cL1.unit || 'A', rw: 'ro', kind: 'dp', dpId: cL1.id });
      if (cL2) add({ relId: this._aliasRelId('r.currentL2'), name: 'Current L2', role: 'value.current', type: 'number', unit: cL2.unit || 'A', rw: 'ro', kind: 'dp', dpId: cL2.id });
      if (cL3) add({ relId: this._aliasRelId('r.currentL3'), name: 'Current L3', role: 'value.current', type: 'number', unit: cL3.unit || 'A', rw: 'ro', kind: 'dp', dpId: cL3.id });

      const freqDp = getAnyById('fREQUENCY');
      if (freqDp) {
        add({
          relId: this._aliasRelId('r.frequency'),
          name: 'Frequency',
          role: 'value.frequency',
          type: 'number',
          unit: freqDp.unit || 'Hz',
          rw: 'ro',
          kind: 'dp',
          dpId: freqDp.id,
        });
      }
    }

    // --- Charging station aliases (EVCS/EVSE/CHARGER/DC_CHARGER) ---
    if (chargerCats.has(cat)) {
      // Read: power
      const chargingPowerDp =
        getAnyById('aCTIVE_POWER') ||
        findByIdRe(/charging_power/i) ||
        findByIdRe(/power_W$/i) ||
        this._findFirstDatapoint(dp => dp.role === 'value.power' && dp.rw !== 'wo' && !/^station_/i.test(String(dp.id))) ||
        this._findFirstDatapoint(dp => dp.role === 'value.power' && dp.rw !== 'wo');

      if (chargingPowerDp) {
        add({
          relId: this._aliasRelId('r.power'),
          name: 'Charging power',
          role: 'value.power',
          type: 'number',
          unit: chargingPowerDp.unit || 'W',
          rw: 'ro',
          kind: 'dp',
          dpId: chargingPowerDp.id,
        });
      }

      // Read: energy session / total
      const energySessionDp =
        getAnyById('eNERGY_SESSION', 'lAST_ENERGY_SESSION') ||
        findByIdRe(/charged_energy_session/i) ||
        findByIdRe(/energy.*session/i) ||
        findByIdOrNameRe(/energy.*session/i);

      if (energySessionDp) {
        add({
          relId: this._aliasRelId('r.energySession'),
          name: 'Energy (session)',
          role: 'value.energy',
          type: 'number',
          unit: energySessionDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: energySessionDp.id,
        });
      }

      const energyTotalDp =
        findByIdRe(/total.*charged.*energy/i) ||
        findByIdRe(/total_charged_energy/i) ||
        findByIdRe(/total.*energy/i) ||
        getAnyById('aCTIVE_PRODUCTION_ENERGY') ||
        this._findFirstDatapoint(dp => dp.role === 'value.energy' && dp.rw !== 'wo' && !/session/i.test(String(dp.id || '') + ' ' + String(dp.name || '')));

      if (energyTotalDp) {
        add({
          relId: this._aliasRelId('r.energyTotal'),
          name: 'Energy (total)',
          role: 'value.energy',
          type: 'number',
          unit: energyTotalDp.unit || 'Wh',
          rw: 'ro',
          kind: 'dp',
          dpId: energyTotalDp.id,
        });
      }

      // Read: status code (best-effort)
      const statusDp =
        getAnyById('eVSE_STATE', 'cHARGE_POINT_STATE', 'gOE_STATE') ||
        this._findFirstDatapoint(dp => /(^state$|_state$)/i.test(String(dp.id || '')) && dp.rw !== 'wo' && !/^station_/i.test(String(dp.id))) ||
        getAnyById('station_state') ||
        this._findFirstDatapoint(dp => /state/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      if (statusDp) {
        add({
          relId: this._aliasRelId('r.statusCode'),
          name: 'Status code',
          role: 'indicator.status',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: statusDp.id,
        });
      }

      // Read: error code -> alarm.fault
      const errorDp =
        getAnyById('eVSE_ERROR_CODE', 'eRROR_CODE') ||
        findByIdRe(/error_code/i) ||
        this._findFirstDatapoint(dp => /error/i.test(String(dp.id || '')) && dp.rw !== 'wo');

      if (errorDp) {
        add({
          relId: this._aliasRelId('r.errorCode'),
          name: 'Error code',
          role: 'indicator',
          type: 'number',
          rw: 'ro',
          kind: 'dp',
          dpId: errorDp.id,
        });

        add({
          relId: this._aliasRelId('alarm.fault'),
          name: 'Fault active',
          role: 'indicator.alarm',
          type: 'boolean',
          rw: 'ro',
          kind: 'computed',
          get: (values) => {
            if (!values) return false;
            const v = values[errorDp.id];
            if (typeof v !== 'number') return false;
            return v !== 0;
          }
        });
      }

      // Control: current limit (A) (best-effort)
      const currentLimitDp =
        getAnyById('sET_CHARGING_CURRENT', 'cHARGE_CURRENT', 'cHARGING_CURRENT', 'currentUser_mA', 'aPPLY_CHARGE_CURRENT_LIMIT') ||
        this._findFirstDatapoint(dp =>
          (dp.rw === 'rw' || dp.rw === 'wo') &&
          /current/i.test(String(dp.id || '')) &&
          !/timeout/i.test(String(dp.id || '')) &&
          !/failsafe/i.test(String(dp.id || ''))
        );

      if (currentLimitDp) {
        const unit = (currentLimitDp.unit === 'mA') ? 'A' : (currentLimitDp.unit || 'A');
        const isMilliAmp = currentLimitDp.unit === 'mA';

        add({
          relId: this._aliasRelId('ctrl.currentLimitA'),
          name: 'Charging current limit',
          role: 'level.current',
          type: 'number',
          unit,
          rw: 'rw',
          kind: 'dp',
          dpId: currentLimitDp.id,
          writeDpId: currentLimitDp.id,
          toDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return isMilliAmp ? Math.round(n * 1000) : n;
          },
          fromDevice: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return isMilliAmp ? (n / 1000) : n;
          }
        });
      }

      // Control: power limit (W) (best-effort)
      const powerLimitDp =
        getAnyById('eV_SET_CHARGE_POWER_LIMIT', 'aPPLY_CHARGE_POWER_LIMIT', 'set_station_max_power') ||
        findByIdRe(/set_c\d+_max_power/i) ||
        findByIdRe(/set_.*max_power/i);

      if (powerLimitDp && (powerLimitDp.rw === 'rw' || powerLimitDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.powerLimitW'),
          name: 'Charging power limit',
          role: 'level.power',
          type: 'number',
          unit: powerLimitDp.unit || 'W',
          rw: 'rw',
          kind: 'dp',
          dpId: powerLimitDp.id,
          writeDpId: powerLimitDp.id,
        });
      }

      // Control: run/stop (enable/disable) (best-effort)
      const enableDp =
        getAnyById('sET_ENABLE', 'enableUser', 'sTART_CANCEL_CHARGING_SESSION') ||
        this._findFirstDatapoint(dp =>
          (dp.rw === 'rw' || dp.rw === 'wo') &&
          (/enable/i.test(String(dp.id || '')) || /start/i.test(String(dp.id || '')) || /stop/i.test(String(dp.id || '')))
        );

      if (enableDp) {
        add({
          relId: this._aliasRelId('ctrl.run'),
          name: 'Run (enable/start)',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: enableDp.id,
          writeDpId: enableDp.id,
          toDevice: (v) => {
            // Many EVCS implementations use 0/1 integer flags for enable/start.
            if (typeof v === 'boolean') return v ? 1 : 0;
            return v;
          },
          fromDevice: (v) => {
            if (typeof v === 'number') return v !== 0;
            if (typeof v === 'boolean') return v;
            return undefined;
          }
        });
      }

      // Control: unlock plug (best-effort)
      const unlockDp = getAnyById('sET_UNLOCK_PLUG');
      if (unlockDp && (unlockDp.rw === 'rw' || unlockDp.rw === 'wo')) {
        add({
          relId: this._aliasRelId('ctrl.unlockPlug'),
          name: 'Unlock plug',
          role: 'switch',
          type: 'boolean',
          rw: 'rw',
          kind: 'dp',
          dpId: unlockDp.id,
          writeDpId: unlockDp.id,
          toDevice: (v) => (v ? 1 : 0),
          fromDevice: (v) => {
            if (typeof v === 'number') return v !== 0;
            if (typeof v === 'boolean') return v;
            return undefined;
          }
        });
      }
    }

    return defs;
  }




  async _initAliasObjects() {
    // Build and validate alias definitions
    const defs = this._buildAliasDefinitions();
    if (!Array.isArray(defs) || !defs.length) return;

    for (const def of defs) {
      if (!def || !def.relId) continue;
      await this._ensureAliasPathChannels(def.relId);

      const common = {
        name: def.name || def.relId.split('.').slice(-1)[0],
        type: def.type || 'string',
        role: def.role || 'state',
        read: def.rw !== 'wo',
        write: def.rw === 'rw' || def.rw === 'wo',
      };
      if (def.unit) common.unit = def.unit;

      await this.adapter.setObjectNotExistsAsync(def.relId, {
        type: 'state',
        common,
        native: {
          deviceId: this.cfg.id,
          templateId: this.cfg.templateId,
          isAlias: true,
          aliasKind: def.kind,
          dpId: def.dpId,
          writeDpId: def.writeDpId,
        }
      });

      this.aliasByStateRelId.set(def.relId, def);
      this.aliasDefs.push(def);
    }
  }

  async _updateAliases(values, ctx) {
    if (!Array.isArray(this.aliasDefs) || !this.aliasDefs.length) return;
    const v = values || {};
    const c = ctx || {};

    for (const def of this.aliasDefs) {
      if (!def || !def.relId) continue;

      let outVal;

      if (def.kind === 'dp') {
        if (!def.dpId) continue;
        if (!Object.prototype.hasOwnProperty.call(v, def.dpId)) {
          // Write-only datapoints won't be present in the poll result. In this case we keep
          // the last commanded value (state stays as-is).
          continue;
        }
        const raw = v[def.dpId];
        if (typeof def.fromDevice === 'function') {
          outVal = def.fromDevice(raw);
          if (outVal === undefined) continue;
        } else {
          outVal = raw;
        }
      } else if (def.kind === 'computed') {
        if (typeof def.get !== 'function') continue;
        outVal = def.get(v, c);
        if (outVal === undefined) continue;
      } else {
        continue;
      }

      await this.adapter.setStateAsync(def.relId, { val: outVal, ack: true }).catch(() => {});
    }
  }

  _createDriver() {
    const proto = this.cfg.protocol;
    if (proto === 'modbusTcp' || proto === 'modbusRtu') {
      return new ModbusDriver(this.adapter, this.cfg, this.template, this.global);
    }
    if (proto === 'mqtt') {
      // MQTT driver needs mapping dp -> state id
      return new MqttDriver(this.adapter, this.cfg, this.template, this.global, (dp) => this.relStateId(dp));
    }
    if (proto === 'http') {
      return new HttpDriver(this.adapter, this.cfg, this.template, this.global);
    }
    if (proto === 'udp') {
      return new UdpDriver(this.adapter, this.cfg, this.template, this.global);
    }
    throw new Error(`Unsupported protocol: ${proto}`);
  }

  async start() {
    if (this.started) return;
    this.started = true;

    if (this.cfg.enabled === false) {
      this.adapter.log.info(`[${this.cfg.id}] disabled - skipping`);
      return;
    }

    this.driver = this._createDriver();

    // MQTT subscribes on connect
    if (this.cfg.protocol === 'mqtt') {
      try {
        await this.driver.connect(this.getDatapoints());
      } catch (e) {
        await this._setError(e);
      }
      // no polling required, but keep connection state
      await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: true, ack: true }).catch(() => {});
      await this.adapter.setStateAsync(`${this.baseId}.info.lastError`, { val: '', ack: true }).catch(() => {});
      await this._updateAliases({}, { connected: true, lastError: '' }).catch(() => {});
      return;
    }

    // polling
    const pollMs = Number(this.cfg.pollIntervalMs || this.global.pollIntervalMs || 5000);
    const doPoll = async () => {
      if (!this.driver) return;
      try {
        const values = await this.driver.readDatapoints(this.getDatapoints());
        this._connOk = true;
        await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: true, ack: true }).catch(() => {});
        await this.adapter.setStateAsync(`${this.baseId}.info.lastError`, { val: '', ack: true }).catch(() => {});
        for (const [dpId, val] of Object.entries(values)) {
          const dp = this.dpById.get(dpId);
          if (!dp) continue;
          const relId = this.relStateId(dp);
          await this.adapter.setStateAsync(relId, { val, ack: true });
        }
        await this._updateAliases(values, { connected: true, lastError: '' });
      } catch (e) {
        await this._setError(e);
      }
    };

    // run once quickly
    await doPoll();

    this.pollTimer = setInterval(doPoll, Math.max(250, pollMs));

    // Optional template-defined Modbus watchdog auto-writes (e.g., TESVOLT VK interface).
    await this._startAutoWatchdogs();
  }

  async _setError(e) {
    const err = e || {};
    this._connOk = false;
    const code = (err && err.code) ? String(err.code) : '';
    let msg = (err && err.message) ? err.message : String(err);

    const host = this.cfg?.connection?.host;
    const port = Number(this.cfg?.connection?.port || 502);

    const addHint = (hint) => {
      if (!hint) return;
      // Avoid hint duplication on repeated retries.
      if (msg.includes(`| Hint:`) && msg.includes(hint)) return;
      msg = `${msg} | Hint: ${hint}`;
    };

    // --- Transport-layer hints ---
    if (code === 'ECONNREFUSED') {
      addHint(
        `TCP connection to ${host || 'device'}:${port} was refused. ` +
        `This usually means the Modbus TCP server is disabled on the device, the IP/port is wrong, ` +
        `or a firewall/ACL actively rejects the connection. ` +
        `For SMA: ensure SMA Modbus/SunSpec Modbus is enabled and verify whether you must connect to a Data Manager instead of the inverter.`
      );
    } else if (code === 'ETIMEDOUT') {
      addHint(
        `TCP connection timed out (no response). This typically indicates packet filtering (firewall), wrong IP/route, ` +
        `or that port ${port} is not reachable from the ioBroker host.`
      );
    } else if (code === 'ENOTFOUND') {
      addHint(`Host name could not be resolved. Check the Host/IP field.`);
    } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      addHint(`Network unreachable. Check routing/VLAN/gateway and that the device is powered on.`);
    }

    // --- Modbus-layer hints (best-effort) ---
    const lower = String(msg).toLowerCase();
    if (lower.includes('illegal data address') || lower.includes('exception code') || lower.includes('illegal function')) {
      addHint(
        `Modbus responded but the register address/function is invalid. ` +
        `Check Address-Offset (often -1 vs 0), ensure the correct template/profile (SMA Modbus vs SunSpec), and verify Unit-ID.`
      );
    }
    if (lower.includes('timed out') && code !== 'ETIMEDOUT') {
      addHint(
        `Modbus timeout. If TCP connects but reads time out, check Unit-ID, allowed Modbus clients, and whether another client (e.g., Data Manager/SCADA) is already connected.`
      );
    }

    this.adapter.log.warn(`[${this.cfg.id}] ${msg}`);
    await this.adapter.setStateAsync(`${this.baseId}.info.connection`, { val: false, ack: true }).catch(() => {});
    await this.adapter.setStateAsync(`${this.baseId}.info.lastError`, { val: msg, ack: true }).catch(() => {});
    await this._updateAliases({}, { connected: false, lastError: msg }).catch(() => {});
  }

  async stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.watchdogStartTimer) {
      clearTimeout(this.watchdogStartTimer);
      this.watchdogStartTimer = null;
    }
    if (this.driver) {
      try { await this.driver.disconnect(); } catch (e) { /* ignore */ }
      this.driver = null;
    }
    this.started = false;
  }

  async handleStateChange(fullId, state) {
    if (!state || state.ack) return;
    // Convert full id -> relative id
    const relPrefix = this.adapter.namespace + '.';
    const relId = fullId.startsWith(relPrefix) ? fullId.substring(relPrefix.length) : fullId;

    // 1) alias write handling (stable interface)
    const aliasDef = this.aliasByStateRelId.get(relId);
    if (aliasDef) {
      if (!(aliasDef.rw === 'rw' || aliasDef.rw === 'wo')) return;
      if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;

      try {
        const targetId = aliasDef.writeDpId || aliasDef.dpId;
        const dp = this._getDpById(targetId);
        if (!dp) throw new Error(`Alias target datapoint not found: ${targetId}`);

        const toDev = (typeof aliasDef.toDevice === 'function') ? aliasDef.toDevice(state.val) : state.val;

        // Optional pre-writes (template hinted), e.g. writing a control mode before an active power setpoint.
        await this._maybeExecutePreWritesForDp(dp.id);
        await this.driver.writeDatapoint(dp, toDev);

        // ack alias with the user value
        await this.adapter.setStateAsync(relId, { val: state.val, ack: true }).catch(() => {});

        // best-effort: keep underlying datapoint + other alias states in sync with the written raw value
        await this._ackWrittenValue(dp, toDev);

        return;
      } catch (e) {
        await this._setError(e);
        return;
      }
    }

    // 2) regular datapoint write handling
    const dp = this.dpByStateRelId.get(relId);
    if (!dp) return;
    if (!(dp.rw === 'rw' || dp.rw === 'wo')) return;
    if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;

    try {
      // Optional pre-writes (template hinted), e.g. writing a control mode before an active power setpoint.
      await this._maybeExecutePreWritesForDp(dp.id);
      await this.driver.writeDatapoint(dp, state.val);
      // ack the written value
      await this.adapter.setStateAsync(relId, { val: state.val, ack: true });
    } catch (e) {
      await this._setError(e);
    }
  }


  _getAutoWatchdogConfig() {
    const hints = this.template?.driverHints?.modbus;
    const cfg = hints?.autoWatchdog || hints?.autoWatchdogs || hints?.watchdog;
    if (!cfg) return null;

    if (cfg === true) {
      // Boolean true is ambiguous without dpIds; require explicit list
      return null;
    }

    const enabled = (cfg.enabled !== false);
    if (!enabled) return null;

    const dpIds = Array.isArray(cfg.dpIds)
      ? cfg.dpIds
      : Array.isArray(cfg.targets)
        ? cfg.targets
        : Array.isArray(cfg)
          ? cfg
          : [];

    const list = (dpIds || []).map(v => String(v)).filter(v => v && v.trim());
    if (!list.length) return null;

    const periodMs = Number(cfg.periodMs ?? cfg.intervalMs ?? 60000);
    const startDelayMs = Number(cfg.startDelayMs ?? 1000);
    const sequenceMin = Number(cfg.sequenceMin ?? 1);
    const sequenceMax = Number(cfg.sequenceMax ?? 1000);

    return {
      periodMs: Number.isFinite(periodMs) ? periodMs : 60000,
      startDelayMs: Number.isFinite(startDelayMs) ? startDelayMs : 1000,
      sequenceMin: Number.isFinite(sequenceMin) ? sequenceMin : 1,
      sequenceMax: Number.isFinite(sequenceMax) ? sequenceMax : 1000,
      dpIds: list,
    };
  }

  async _startAutoWatchdogs() {
    // Only applies to Modbus devices
    const proto = this.cfg?.protocol;
    if (proto !== 'modbusTcp' && proto !== 'modbusRtu') return;

    const cfg = this._getAutoWatchdogConfig();
    if (!cfg) return;

    if (this.watchdogTimer || this.watchdogStartTimer) return;

    // Resolve writable datapoints
    const dps = [];
    for (const dpId of cfg.dpIds) {
      const dp = this._getDpById(dpId);
      if (!dp) {
        this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog: datapoint not found: ${dpId}`);
        continue;
      }
      if (!(dp.rw === 'rw' || dp.rw === 'wo')) {
        this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog: datapoint not writable: ${dpId}`);
        continue;
      }
      dps.push(dp);
    }

    if (!dps.length) return;

    const periodMs = Math.max(10000, Number(cfg.periodMs || 60000));
    const startDelayMs = Math.max(0, Number(cfg.startDelayMs || 1000));

    const minVal = Math.trunc(Number(cfg.sequenceMin || 1));
    const maxValRaw = Math.trunc(Number(cfg.sequenceMax || 1000));
    const maxVal = Number.isFinite(maxValRaw) && maxValRaw >= minVal ? maxValRaw : 1000;

    // Initialize counter so the first tick yields minVal
    if (!Number.isFinite(this._watchdogCounter) || this._watchdogCounter < minVal || this._watchdogCounter > maxVal) {
      this._watchdogCounter = minVal - 1;
    }

    const tick = async () => {
      if (this._watchdogBusy) return;
      this._watchdogBusy = true;
      try {
        if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;
        if (!this._connOk) return; // only when connected

        // Avoid colliding with ongoing read polls
        if (this.driver && this.driver._busy) return;

        // Ramp min..max (loop)
        let next = this._watchdogCounter + 1;
        if (next > maxVal) next = minVal;
        this._watchdogCounter = next;

        for (const dp of dps) {
          await this.driver.writeDatapoint(dp, next);
          await this._ackWrittenValue(dp, next);
        }
        this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog tick -> ${next}`);
      } catch (e) {
        // Best-effort: do not spam warnings; poll loop will surface transport errors.
        this.adapter.log.debug(`[${this.cfg.id}] AutoWatchdog error: ${e && e.message ? e.message : e}`);
      } finally {
        this._watchdogBusy = false;
      }
    };

    // Fire once shortly after start, then periodically
    this.watchdogStartTimer = setTimeout(() => { tick(); }, startDelayMs);
    this.watchdogTimer = setInterval(() => { tick(); }, periodMs);

    this.adapter.log.info(`[${this.cfg.id}] AutoWatchdog enabled: dpIds=[${dps.map(d => d.id).join(', ')}], periodMs=${periodMs}`);
  }

  _getPreWritesForDp(dpId) {
    const id = (dpId ?? '').toString();
    if (!id) return [];
    const hints = this.template?.driverHints?.modbus;
    const cfg = hints?.preWrites;
    if (!Array.isArray(cfg) || !cfg.length) return [];

    const wanted = id.toLowerCase();
    const out = [];
    for (const rule of cfg) {
      if (!rule) continue;
      const trig = (rule.triggerDpId ?? rule.onWriteDpId ?? '').toString().toLowerCase();
      if (!trig || trig !== wanted) continue;
      const writes = Array.isArray(rule.writes) ? rule.writes : [];
      for (const w of writes) {
        if (!w || !w.dpId) continue;
        if (w.value === undefined) continue;
        out.push({ dpId: String(w.dpId), value: w.value });
      }
    }
    return out;
  }

  async _maybeExecutePreWritesForDp(dpId) {
    if (!this.driver || typeof this.driver.writeDatapoint !== 'function') return;
    const plan = this._getPreWritesForDp(dpId);
    if (!plan.length) return;

    for (const step of plan) {
      try {
        const dp = this._getDpById(step.dpId);
        if (!dp) continue;
        if (!(dp.rw === 'rw' || dp.rw === 'wo')) continue;
        await this.driver.writeDatapoint(dp, step.value);
        await this._ackWrittenValue(dp, step.value);
      } catch (e) {
        // Pre-write failure should surface clearly (it affects the main command).
        throw e;
      }
    }
  }

  async _ackWrittenValue(dp, rawValue) {
    if (!dp || !dp.id) return;

    // Update underlying datapoint state
    const dpRelId = this.relStateId(dp);
    await this.adapter.setStateAsync(dpRelId, { val: rawValue, ack: true }).catch(() => {});

    // Update all alias states that reference this datapoint (best-effort)
    if (!Array.isArray(this.aliasDefs) || !this.aliasDefs.length) return;
    for (const def of this.aliasDefs) {
      try {
        if (!def || def.kind !== 'dp' || def.dpId !== dp.id) continue;
        let outVal = rawValue;
        if (typeof def.fromDevice === 'function') {
          outVal = def.fromDevice(rawValue);
          if (outVal === undefined) continue;
        }
        await this.adapter.setStateAsync(def.relId, { val: outVal, ack: true }).catch(() => {});
      } catch (_) {
        // ignore
      }
    }
  }
}

module.exports = {
  DeviceRuntime,
};