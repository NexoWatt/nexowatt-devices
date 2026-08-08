'use strict';

const mqtt = require('mqtt');
const { getByJsonPath, applyNumericTransforms, coerceBoolean } = require('../utils');

function hasOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function applyValueMap(value, valueMap, defaultValue) {
  if (!valueMap || typeof valueMap !== 'object') return value;
  const key = String(value);
  if (hasOwn(valueMap, key)) return valueMap[key];
  if (defaultValue !== undefined) return defaultValue;
  return value;
}

function parseJsonValue(value) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function sameStateValue(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  return false;
}

class MqttDriver {
  constructor(
    adapter,
    deviceCfg,
    template,
    globalCfg,
    relStateIdFn,
    roundingDecimalsFn,
    onAliveFn,
    onValuesFn,
    onConnectionFn,
  ) {
    this.adapter = adapter;
    this.device = deviceCfg || {};
    this.template = template || {};
    this.global = globalCfg || {};
    this.relStateId = relStateIdFn;
    this.roundingDecimals = roundingDecimalsFn;

    // Optional callbacks supplied by DeviceRuntime.
    this.onAlive = (typeof onAliveFn === 'function') ? onAliveFn : null;
    this.onValues = (typeof onValuesFn === 'function') ? onValuesFn : null;
    this.onConnection = (typeof onConnectionFn === 'function') ? onConnectionFn : null;

    this.client = null;
    this.connected = false;

    this.hints = (this.template.driverHints && this.template.driverHints.mqtt) || {};

    // A single MQTT JSON object commonly contains many values. Keep all datapoints
    // for a topic instead of the previous one-topic/one-datapoint cache.
    this.dpsByTopic = new Map();
    // Compatibility alias for older tests/integrations that may inspect the property.
    this.dpByTopic = this.dpsByTopic;
    this.dpById = new Map();

    // Last successfully parsed engineering values. This full snapshot is passed back
    // to DeviceRuntime so canonical aliases can be updated for event-driven protocols.
    this.valueCache = Object.create(null);
    this.updatedAtByDpId = new Map();
    this.commandCache = new Map();
    this.lastStateWriteByDpId = new Map();
    this.lastSourceTimestampByTopic = new Map();

    this._offlineApplied = false;
    this._lastConnectionNotification = null;
  }

  async connect() {
    const connection = this.device.connection || {};
    const url = String(connection.url || '').trim();
    if (!url) throw new Error('Missing MQTT url');

    const options = {
      username: connection.username || undefined,
      password: connection.password || undefined,
      clientId: connection.clientId || `nexowatt-${this.device.id || 'device'}-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: Number.isFinite(Number(connection.reconnectPeriodMs))
        ? Math.max(0, Number(connection.reconnectPeriodMs))
        : 5000,
      connectTimeout: Number.isFinite(Number(connection.connectTimeoutMs))
        ? Math.max(1000, Number(connection.connectTimeoutMs))
        : 10000,
      keepalive: Number.isFinite(Number(connection.keepaliveSeconds))
        ? Math.max(5, Number(connection.keepaliveSeconds))
        : 30,
      clean: connection.cleanSession !== false,
    };

    // mqtts:// works with the normal mqtt package. Advanced certificate handling can
    // be added once TESVOLT confirms its TLS requirements; system-trusted CAs already work.
    if (connection.rejectUnauthorized !== undefined) {
      options.rejectUnauthorized = connection.rejectUnauthorized !== false;
    }

    this.client = mqtt.connect(url, options);

    this.client.on('connect', () => {
      this.connected = true;
      this._offlineApplied = false;
      this.adapter.log.info(`[${this.device.id}] MQTT connected`);
      this._subscribeAll();
      this._notifyConnection(true, '');
    });

    this.client.on('reconnect', () => {
      this.adapter.log.debug(`[${this.device.id}] MQTT reconnecting`);
    });

    this.client.on('offline', () => {
      this.connected = false;
      this._notifyConnection(false, 'MQTT offline');
    });

    this.client.on('close', () => {
      this.connected = false;
      this._notifyConnection(false, 'MQTT connection closed');
    });

    this.client.on('error', (error) => {
      const message = error && error.message ? error.message : String(error);
      this.adapter.log.warn(`[${this.device.id}] MQTT error: ${message}`);
      if (!this.connected) this._notifyConnection(false, message);
    });

    this.client.on('message', (topic, payload) => {
      this._handleMessage(topic, payload).catch((error) => {
        const message = error && error.message ? error.message : String(error);
        this.adapter.log.warn(`[${this.device.id}] MQTT message handling failed for ${topic}: ${message}`);
      });
    });
  }

  _notifyConnection(connected, errorMessage) {
    if (!this.onConnection) return;
    const next = !!connected;
    if (this._lastConnectionNotification === next && !errorMessage) return;
    this._lastConnectionNotification = next;
    try {
      const result = this.onConnection(next, errorMessage || '');
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {
      // Connection notifications must never crash the MQTT client.
    }
  }

  _subscribeAll() {
    if (!this.client) return;

    this.dpsByTopic.clear();
    this.dpById.clear();

    const datapoints = Array.isArray(this.template.datapoints) ? this.template.datapoints : [];
    for (const dp of datapoints) {
      if (!dp || !dp.id) continue;
      this.dpById.set(String(dp.id), dp);

      const source = dp.source || {};
      if (source.kind !== 'mqtt' || !source.topic) continue;
      // Write-only command topics are not subscribed unless explicitly requested.
      if (dp.rw === 'wo' && source.subscribe !== true) continue;
      if (source.subscribe === false) continue;

      const topic = String(source.topic);
      if (!this.dpsByTopic.has(topic)) this.dpsByTopic.set(topic, []);
      this.dpsByTopic.get(topic).push(dp);
    }

    for (const [topic, dps] of this.dpsByTopic.entries()) {
      const qos = dps.reduce((current, dp) => {
        const candidate = Number(dp && dp.source && dp.source.qos);
        return Number.isFinite(candidate) ? Math.max(current, Math.max(0, Math.min(2, candidate))) : current;
      }, 0);

      this.client.subscribe(topic, { qos }, (error) => {
        if (error) {
          this.adapter.log.warn(`[${this.device.id}] MQTT subscribe error for ${topic}: ${error.message || error}`);
        }
      });
    }
  }

  async disconnect() {
    try {
      if (this.client) {
        await new Promise((resolve) => this.client.end(false, {}, resolve));
      }
    } catch (_) {
      // ignore
    } finally {
      this.connected = false;
      this.client = null;
      this._notifyConnection(false, 'MQTT disconnected');
    }
  }

  _extractSourceTimestamp(parsedJson) {
    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) return 0;
    const field = String(this.hints.timestampField || 'ts_create');
    const raw = parsedJson[field];
    if (typeof raw !== 'string' || !raw.trim()) return 0;
    const timestamp = Date.parse(raw);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  async _handleMessage(topic, payload) {
    const datapoints = this.dpsByTopic.get(topic);
    if (!datapoints || !datapoints.length) return;

    const receivedAt = Date.now();
    let parsedJson;
    const needsJson = datapoints.some((dp) => {
      const source = dp.source || {};
      return String(source.format || '').toLowerCase() === 'json' || !!source.jsonPath;
    });

    if (needsJson) {
      try {
        parsedJson = JSON.parse(payload.toString('utf8'));
      } catch (error) {
        throw new Error(`Invalid JSON: ${error.message || error}`);
      }
    }

    const sourceTimestamp = this._extractSourceTimestamp(parsedJson);
    if (sourceTimestamp > 0) {
      const previous = Number(this.lastSourceTimestampByTopic.get(topic)) || 0;
      if (previous > 0 && sourceTimestamp < previous) {
        this.adapter.log.debug(
          `[${this.device.id}] MQTT ignored older message for ${topic}: ${sourceTimestamp} < ${previous}`,
        );
        return;
      }
      this.lastSourceTimestampByTopic.set(topic, sourceTimestamp);
    }

    let parsedCount = 0;
    for (const dp of datapoints) {
      try {
        const value = this._parsePayload(dp, payload, parsedJson);
        if (value === undefined) continue;
        // Preserve historical MQTT behaviour: every received sample updates the raw
        // ioBroker state timestamp even when its value is unchanged. Freshness-sensitive
        // existing installations may rely on the state timestamp.
        await this._setDatapointValue(dp, value, receivedAt, { markFresh: true, forceWrite: true });
        parsedCount += 1;
      } catch (error) {
        this.adapter.log.warn(
          `[${this.device.id}] MQTT parse failed for ${topic}/${dp.id}: ${error.message || error}`,
        );
      }
    }

    const derivedCount = await this._evaluateDerivedDatapoints(receivedAt);
    const staleCount = await this._applyStaleValues(receivedAt, false);

    // A syntactically valid JSON message on a subscribed topic proves liveness even
    // when optional fields are absent. Plain-text topics prove liveness only after at
    // least one datapoint was parsed successfully. Invalid payloads never tick it.
    const validKnownMessage = needsJson ? parsedJson !== undefined : parsedCount > 0;
    if (parsedCount > 0 || derivedCount > 0 || staleCount > 0 || validKnownMessage) {
      this._offlineApplied = false;
      try {
        const alive = this.onAlive && this.onAlive();
        if (alive && typeof alive.catch === 'function') alive.catch(() => {});
      } catch (_) {
        // ignore
      }

      await this._notifyValues({
        connected: true,
        topic,
        receivedAt,
        sourceTimestamp,
      });
    }
  }

  async _notifyValues(meta) {
    if (!this.onValues) return;
    try {
      await this.onValues({ ...this.valueCache }, meta || {});
    } catch (error) {
      this.adapter.log.debug(
        `[${this.device.id}] MQTT alias snapshot callback failed: ${error && error.message ? error.message : error}`,
      );
    }
  }

  _parsePayload(dp, payload, parsedJson) {
    const source = dp.source || {};
    const format = String(source.format || dp.type || 'string').toLowerCase();
    const expectedType = String(dp.type || '').toLowerCase();
    const text = payload.toString('utf8');

    const needsJson = String(source.format || '').toLowerCase() === 'json' || !!source.jsonPath;
    let value;

    if (needsJson) {
      const object = parsedJson !== undefined ? parsedJson : JSON.parse(text);
      value = source.jsonPath ? getByJsonPath(object, source.jsonPath) : object;
    } else if (format === 'number' || format === 'float' || format === 'int') {
      const numberValue = Number(text);
      if (!Number.isFinite(numberValue)) throw new Error(`Not a number: ${text}`);
      value = numberValue;
    } else if (format === 'boolean' || format === 'bool') {
      if (text === '1' || text.toLowerCase() === 'true' || text.toLowerCase() === 'on') value = true;
      else if (text === '0' || text.toLowerCase() === 'false' || text.toLowerCase() === 'off') value = false;
      else value = !!text;
    } else {
      value = text;
    }

    if (source.readValueMap && typeof source.readValueMap === 'object') {
      value = applyValueMap(value, source.readValueMap, source.readValueMapDefault);
    }

    // Apply numeric transforms (scaleFactor, multiplier, divisor, offset, invert, ...)
    value = applyNumericTransforms(value, source);

    if (value === undefined) return undefined;

    if (expectedType === 'boolean') {
      value = coerceBoolean(value);
    } else if (expectedType === 'number') {
      // Preserve explicit null from the source instead of turning it into 0.
      if (value === null) return null;
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) {
        throw new Error(`Expected numeric value, received ${JSON.stringify(value)}`);
      }
      value = numberValue;
    } else if (expectedType === 'string' && value && typeof value === 'object') {
      value = JSON.stringify(value);
    }

    const decimals = this.roundingDecimals ? this.roundingDecimals(dp) : null;
    if (typeof value === 'number' && decimals !== null && decimals !== undefined) {
      const factor = Math.pow(10, decimals);
      value = Math.round(value * factor) / factor;
    }

    return value;
  }

  async _setDatapointValue(dp, value, timestamp, options) {
    if (!dp || !dp.id) return false;
    const id = String(dp.id);
    const opts = options || {};

    if (opts.markFresh !== false) this.updatedAtByDpId.set(id, timestamp || Date.now());
    this.valueCache[id] = value;

    const previous = this.lastStateWriteByDpId.get(id);
    if (sameStateValue(previous, value) && opts.forceWrite !== true) return false;
    this.lastStateWriteByDpId.set(id, value);

    const stateId = this.relStateId ? this.relStateId(dp) : dp.id;
    await this.adapter.setStateAsync(stateId, { val: value, ack: true }).catch(() => {});
    return true;
  }

  _collectionLength(value) {
    const parsed = parseJsonValue(value);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length;
    return 0;
  }

  _computeDerivedValue(source) {
    const operation = String(source.op || '').toLowerCase();
    const inputs = Array.isArray(source.inputs) ? source.inputs : [];

    if (operation === 'anyequals') {
      return inputs.some((input) => {
        if (!input || !input.dpId) return false;
        return String(this.valueCache[input.dpId]) === String(input.equals);
      }) ? 1 : 0;
    }

    if (operation === 'arraylengthsum') {
      return inputs.reduce((sum, input) => {
        if (!input || !input.dpId) return sum;
        return sum + this._collectionLength(this.valueCache[input.dpId]);
      }, 0);
    }

    if (operation === 'alltruthy') {
      return inputs.every((input) => input && input.dpId && coerceBoolean(this.valueCache[input.dpId])) ? 1 : 0;
    }

    return undefined;
  }

  async _evaluateDerivedDatapoints(timestamp) {
    let changes = 0;
    const datapoints = Array.isArray(this.template.datapoints) ? this.template.datapoints : [];
    for (const dp of datapoints) {
      const source = dp && dp.source ? dp.source : {};
      if (source.kind !== 'mqttDerived') continue;
      const value = this._computeDerivedValue(source);
      if (value === undefined) continue;
      if (await this._setDatapointValue(dp, value, timestamp, { markFresh: true })) changes += 1;
    }
    return changes;
  }

  async _applyStaleValues(now, forceOffline) {
    let changes = 0;
    const offlineIds = new Set(
      Array.isArray(this.hints.zeroOnOfflineDpIds)
        ? this.hints.zeroOnOfflineDpIds.map((value) => String(value))
        : [],
    );

    const datapoints = Array.isArray(this.template.datapoints) ? this.template.datapoints : [];
    for (const dp of datapoints) {
      if (!dp || !dp.id) continue;
      const source = dp.source || {};
      if (source.kind !== 'mqtt') continue;

      const forceThis = !!forceOffline && (source.zeroOnOffline === true || offlineIds.has(String(dp.id)));
      const staleAfterMs = Number(source.staleAfterMs);
      const lastUpdate = Number(this.updatedAtByDpId.get(String(dp.id))) || 0;
      const timedOut = !forceOffline && Number.isFinite(staleAfterMs) && staleAfterMs > 0 &&
        lastUpdate > 0 && (now - lastUpdate) > staleAfterMs;

      if (!forceThis && !timedOut) continue;
      const staleValue = source.staleValue !== undefined ? source.staleValue : 0;
      if (await this._setDatapointValue(dp, staleValue, now, { markFresh: false })) changes += 1;
    }
    return changes;
  }

  async handleOffline(reason) {
    if (this._offlineApplied) return;
    this._offlineApplied = true;
    await this._applyStaleValues(Date.now(), true);
    await this._evaluateDerivedDatapoints(Date.now());
    await this._notifyValues({ connected: false, stale: true, error: reason || '' });
  }

  _formatPayload(dp, value) {
    const source = dp.source || {};
    const format = String(source.format || dp.type || 'string').toLowerCase();

    let mapped = applyValueMap(value, source.valueMap);
    if (source.writeInvert && typeof mapped === 'number') mapped = -mapped;
    if (source.writeMultiplier !== undefined && Number.isFinite(Number(source.writeMultiplier))) {
      mapped = Number(mapped) * Number(source.writeMultiplier);
    }
    if (source.writeDivisor !== undefined && Number.isFinite(Number(source.writeDivisor)) && Number(source.writeDivisor) !== 0) {
      mapped = Number(mapped) / Number(source.writeDivisor);
    }
    if (source.writeOffset !== undefined && Number.isFinite(Number(source.writeOffset))) {
      mapped = Number(mapped) + Number(source.writeOffset);
    }

    if (format === 'json') return JSON.stringify(mapped);
    if (format === 'boolean' || format === 'bool') return mapped ? '1' : '0';
    if (format === 'number' || format === 'float' || format === 'int') return String(Number(mapped));
    return String(mapped);
  }

  _parseStringArrayFromCache(dpId) {
    const parsed = parseJsonValue(this.valueCache[dpId]);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  }

  _isFresh(dpId, maxAgeMs) {
    const timestamp = Number(this.updatedAtByDpId.get(String(dpId))) || 0;
    if (!timestamp) return false;
    return (Date.now() - timestamp) <= maxAgeMs;
  }

  _normalizePowerCommand(dp, requestedValue) {
    const config = this.hints.powerControl || {};
    if (!config || String(config.dpId || '') !== String(dp.id || '')) return Number(requestedValue);

    const requested = Number(requestedValue);
    if (!Number.isFinite(requested)) throw new Error(`Invalid TESVOLT power setpoint: ${requestedValue}`);

    const apiVersionDpId = String(config.apiVersionDpId || '');
    const requiredApiVersion = String(config.requiredApiVersion || '');
    if (apiVersionDpId && requiredApiVersion) {
      const actual = String(this.valueCache[apiVersionDpId] || '');
      if (actual !== requiredApiVersion) {
        throw new Error(`TESVOLT MQTT API ${requiredApiVersion} required, received ${actual || 'no version yet'}`);
      }
    }

    // After API V2 is confirmed, 0 W is always allowed as a stop request. It does
    // not depend on dynamic limits or the current battery state.
    if (requested === 0) return 0;

    const supportedControlDpId = String(config.supportedControlDpId || '');
    if (supportedControlDpId) {
      const controls = this._parseStringArrayFromCache(supportedControlDpId);
      if (!controls.includes('Power')) {
        throw new Error('TESVOLT inverter does not advertise Power in supported_control');
      }
    }

    const inverterStateDpId = String(config.inverterStateDpId || '');
    const blockedInverterStates = Array.isArray(config.blockedInverterStates)
      ? config.blockedInverterStates.map((state) => String(state))
      : ['fault'];
    const inverterStateFreshnessMs = Number(config.inverterStateFreshnessMs || 30000);
    if (inverterStateDpId) {
      if (!this._isFresh(inverterStateDpId, inverterStateFreshnessMs)) {
        throw new Error(`TESVOLT inverter state is stale or missing (>${inverterStateFreshnessMs} ms)`);
      }
      const state = String(this.valueCache[inverterStateDpId] || '');
      if (!state) throw new Error('TESVOLT inverter state is empty');
      if (blockedInverterStates.includes(state)) {
        throw new Error(`TESVOLT inverter state ${state} blocks power control`);
      }
    }

    const batteryStateDpId = String(config.batteryStateDpId || '');
    const allowedBatteryStates = Array.isArray(config.allowedBatteryStates)
      ? config.allowedBatteryStates.map((state) => String(state))
      : ['normal'];
    const stateFreshnessMs = Number(config.stateFreshnessMs || 5000);
    if (batteryStateDpId) {
      if (!this._isFresh(batteryStateDpId, stateFreshnessMs)) {
        throw new Error(`TESVOLT battery state is stale or missing (>${stateFreshnessMs} ms)`);
      }
      const state = String(this.valueCache[batteryStateDpId] || '');
      if (!allowedBatteryStates.includes(state)) {
        throw new Error(`TESVOLT battery state ${state || 'unknown'} does not allow a non-zero power command`);
      }
    }

    const limitsFreshnessMs = Number(config.limitsFreshnessMs || 60000);
    const chargeLimitDpId = String(config.chargeLimitDpId || '');
    const dischargeLimitDpId = String(config.dischargeLimitDpId || '');
    const relevantLimitDpId = requested < 0 ? chargeLimitDpId : dischargeLimitDpId;

    if (relevantLimitDpId) {
      if (!this._isFresh(relevantLimitDpId, limitsFreshnessMs)) {
        throw new Error(`TESVOLT power limit ${relevantLimitDpId} is stale or missing (>${limitsFreshnessMs} ms)`);
      }
      const limit = Number(this.valueCache[relevantLimitDpId]);
      if (!Number.isFinite(limit) || limit < 0) {
        throw new Error(`TESVOLT power limit ${relevantLimitDpId} is invalid: ${this.valueCache[relevantLimitDpId]}`);
      }

      const magnitude = Math.abs(requested);
      if (magnitude > limit) {
        const clamped = requested < 0 ? -limit : limit;
        this.adapter.log.warn(
          `[${this.device.id}] TESVOLT power setpoint ${requested} W limited to ${clamped} W by ${relevantLimitDpId}`,
        );
        return clamped;
      }
    }

    return requested;
  }

  _transformWriteFieldValue(value, field) {
    let transformed = value;
    if (field && field.invert && typeof transformed === 'number') transformed = -transformed;
    if (field && field.multiplier !== undefined && Number.isFinite(Number(field.multiplier))) {
      transformed = Number(transformed) * Number(field.multiplier);
    }
    if (field && field.divisor !== undefined && Number.isFinite(Number(field.divisor)) && Number(field.divisor) !== 0) {
      transformed = Number(transformed) / Number(field.divisor);
    }
    if (field && field.offset !== undefined && Number.isFinite(Number(field.offset))) {
      transformed = Number(transformed) + Number(field.offset);
    }
    return transformed;
  }

  _buildWriteGroupPayload(dp, value, group) {
    const supportedControlDpId = String((this.hints.powerControl || {}).supportedControlDpId || '');
    const supportedControls = supportedControlDpId ? this._parseStringArrayFromCache(supportedControlDpId) : [];
    const supportedKnown = supportedControls.length > 0;
    const fields = group && group.fields && typeof group.fields === 'object' ? group.fields : {};
    const payload = {};

    for (const [jsonKey, fieldDefinition] of Object.entries(fields)) {
      const field = fieldDefinition || {};
      if (field.includeIfSupported) {
        const capability = String(field.includeIfSupported);
        if (supportedKnown && !supportedControls.includes(capability)) continue;
        if (!supportedKnown && field.includeIfUnknown === false) continue;
      }

      let fieldValue;
      if (field.dpId) {
        const fieldDpId = String(field.dpId);
        if (fieldDpId === String(dp.id)) fieldValue = value;
        else if (this.commandCache.has(fieldDpId)) fieldValue = this.commandCache.get(fieldDpId);
        else if (field.default !== undefined) fieldValue = field.default;
      } else if (field.value !== undefined) {
        fieldValue = field.value;
      } else if (field.default !== undefined) {
        fieldValue = field.default;
      }

      if (fieldValue === undefined) {
        if (field.required) throw new Error(`Missing MQTT write-group field ${jsonKey}`);
        continue;
      }

      payload[jsonKey] = this._transformWriteFieldValue(fieldValue, field);
    }

    return payload;
  }

  async _publish(topic, payload, options, requireConnected) {
    if (!this.client) throw new Error('MQTT not connected');
    if (requireConnected && !this.connected) throw new Error('MQTT not connected');
    await new Promise((resolve, reject) => {
      this.client.publish(topic, payload, options, (error) => error ? reject(error) : resolve());
    });
  }

  async readDatapoints(/* datapoints */) {
    // MQTT is event-driven; nothing to poll here.
    return {};
  }

  async writeDatapoint(dp, value) {
    const source = dp.source || {};
    if (!this.client) throw new Error('MQTT not connected');

    const writeGroupName = source.writeGroup ? String(source.writeGroup) : '';
    if (writeGroupName) {
      if (!this.connected) throw new Error('MQTT not connected');
      const writeGroups = this.hints.writeGroups || {};
      const group = writeGroups[writeGroupName];
      if (!group) throw new Error(`Unknown MQTT write group: ${writeGroupName}`);

      let effectiveValue = value;
      if (String((this.hints.powerControl || {}).dpId || '') === String(dp.id || '')) {
        effectiveValue = this._normalizePowerCommand(dp, value);
      }
      this.commandCache.set(String(dp.id), effectiveValue);

      const payloadObject = this._buildWriteGroupPayload(dp, effectiveValue, group);
      const topic = String(group.topic || source.topic || '');
      if (!topic) throw new Error(`Missing MQTT write-group topic for ${writeGroupName}`);

      const qos = Number.isFinite(Number(group.qos)) ? Math.max(0, Math.min(2, Number(group.qos))) : 0;
      const retain = group.retain === true;
      const payload = JSON.stringify(payloadObject);
      // Safety-sensitive grouped commands must not be queued across a broken
      // connection; the runtime can issue a fresh command after current states return.
      await this._publish(topic, payload, { qos, retain }, true);

      return {
        effectiveValue,
        topic,
        payload: payloadObject,
      };
    }

    const topic = String(source.topic || '');
    if (!topic) throw new Error('Missing topic');

    const payload = this._formatPayload(dp, value);
    const qos = Number.isFinite(Number(source.qos)) ? Math.max(0, Math.min(2, Number(source.qos))) : 0;
    const retain = source.retain === true;
    await this._publish(topic, payload, { qos, retain }, false);
    return { effectiveValue: value, topic, payload };
  }
}

module.exports = {
  MqttDriver,
  applyValueMap,
};
