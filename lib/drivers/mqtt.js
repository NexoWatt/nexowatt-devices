'use strict';

const fs = require('node:fs');
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

    // Template-driven cyclic write groups (used by the TESVOLT MQTT V2 EMS
    // interface). The gateway expects recurring setpoints and otherwise marks
    // the external EMS offline. State is kept only in memory and is never
    // restored as a non-zero command after a reconnect or adapter restart.
    this.writeGroupStates = new Map();
    this.writeGroupTimers = new Map();
    this._disconnecting = false;
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

    // mqtts:// works with the normal mqtt package. Username/password provide
    // authentication; transport encryption is provided only by mqtts/TLS.
    if (connection.rejectUnauthorized !== undefined) {
      options.rejectUnauthorized = connection.rejectUnauthorized !== false;
    }
    if (connection.servername) options.servername = String(connection.servername).trim();

    const caFile = String(connection.caFile || '').trim();
    const caCertificate = String(connection.caCertificate || connection.ca || '').trim();
    if (caFile) {
      try {
        options.ca = fs.readFileSync(caFile);
      } catch (error) {
        throw new Error(`Cannot read MQTT TLS CA file ${caFile}: ${error && error.message ? error.message : error}`);
      }
    } else if (caCertificate) {
      // Allow both literal PEM and JSON-configured strings containing escaped newlines.
      options.ca = caCertificate.replace(/\\n/g, '\n');
    }

    this.client = mqtt.connect(url, options);

    this.client.on('connect', () => {
      this.connected = true;
      this._disconnecting = false;
      this._offlineApplied = false;
      this.adapter.log.info(`[${this.device.id}] MQTT connected`);
      this._subscribeAll();
      this._markWriteGroupsConnected();
      this._notifyConnection(true, '');
    });

    this.client.on('reconnect', () => {
      this.adapter.log.debug(`[${this.device.id}] MQTT reconnecting`);
    });

    this.client.on('offline', () => {
      this.connected = false;
      this._markWriteGroupsDisconnected('MQTT offline');
      this._notifyConnection(false, 'MQTT offline');
    });

    this.client.on('close', () => {
      this.connected = false;
      if (!this._disconnecting) this._markWriteGroupsDisconnected('MQTT connection closed');
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

    this._initializeWriteGroupStates();
  }

  async disconnect() {
    this._disconnecting = true;
    try {
      if (this.client && this.connected) {
        await this._sendSafeWriteGroupsOnDisconnect();
      }
      this._stopWriteGroupTimers();
      if (this.client) {
        await new Promise((resolve) => this.client.end(false, {}, resolve));
      }
    } catch (_) {
      // ignore
    } finally {
      this.connected = false;
      this.client = null;
      this._disconnecting = false;
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
    const trackingCount = await this._evaluateControlTracking(receivedAt);
    await this._maybeSendPendingSafeValues();

    // A syntactically valid JSON message on a subscribed topic proves liveness even
    // when optional fields are absent. Plain-text topics prove liveness only after at
    // least one datapoint was parsed successfully. Invalid payloads never tick it.
    const validKnownMessage = needsJson ? parsedJson !== undefined : parsedCount > 0;
    if (parsedCount > 0 || derivedCount > 0 || staleCount > 0 || trackingCount > 0 || validKnownMessage) {
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
    await this._setControlTrackingStatus('offline', false, 0, Date.now());
    await this._notifyValues({ connected: false, stale: true, error: reason || '' });
  }

  _connectionNumber(name, fallback) {
    const connection = this.device.connection || {};
    const value = Number(connection[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  _groupRefreshIntervalMs(group) {
    const configured = this._connectionNumber('tesvoltSetpointIntervalMs', 0);
    const templateValue = Number(group && group.refreshIntervalMs);
    const value = configured > 0 ? configured : templateValue;
    return Number.isFinite(value) && value > 0 ? Math.max(1000, value) : 0;
  }

  _groupCommandFreshnessMs(group) {
    const configured = this._connectionNumber('tesvoltCommandSourceTimeoutMs', 0);
    const templateValue = Number(group && group.commandFreshnessMs);
    const value = configured > 0 ? configured : templateValue;
    return Number.isFinite(value) && value > 0 ? Math.max(1000, value) : 0;
  }

  _telemetryFreshnessMs(defaultValue) {
    return this._connectionNumber('tesvoltTelemetryStaleMs', defaultValue);
  }

  _trackingDelayMs(defaultValue) {
    return this._connectionNumber('tesvoltTrackingDelayMs', defaultValue);
  }

  _writeGroups() {
    return (this.hints.writeGroups && typeof this.hints.writeGroups === 'object')
      ? this.hints.writeGroups
      : {};
  }

  _writeGroupCommandDp(group) {
    const fields = group && group.fields && typeof group.fields === 'object' ? group.fields : {};
    const preferred = String((this.hints.powerControl || {}).dpId || '');
    for (const field of Object.values(fields)) {
      if (field && field.dpId && String(field.dpId) === preferred) return this.dpById.get(preferred) || null;
    }
    for (const field of Object.values(fields)) {
      if (field && field.dpId) return this.dpById.get(String(field.dpId)) || null;
    }
    return null;
  }

  _initializeWriteGroupStates() {
    for (const [groupName, group] of Object.entries(this._writeGroups())) {
      if (!group || this._groupRefreshIntervalMs(group) <= 0) continue;
      let state = this.writeGroupStates.get(groupName);
      const dp = this._writeGroupCommandDp(group);
      if (!dp) continue;
      if (!state) {
        const safeValue = Number.isFinite(Number(group.safeValue)) ? Number(group.safeValue) : 0;
        state = {
          groupName,
          dp,
          requestedValue: safeValue,
          effectiveValue: safeValue,
          lastExternalWriteAt: 0,
          lastSentAt: 0,
          lastSentValue: null,
          lastCommandChangedAt: 0,
          requiresFreshCommand: group.safeOnInitialConnect !== false,
          refreshBusy: false,
          staleLogged: false,
          blockLogged: false,
        };
        this.writeGroupStates.set(groupName, state);
      } else {
        state.dp = dp;
      }
      this._scheduleWriteGroupRefresh(groupName, group, state);
    }
  }

  _scheduleWriteGroupRefresh(groupName, group, state) {
    const intervalMs = this._groupRefreshIntervalMs(group);
    if (intervalMs <= 0 || this.writeGroupTimers.has(groupName)) return;
    const timer = setInterval(() => {
      this._refreshWriteGroup(groupName, 'interval').catch((error) => {
        this.adapter.log.debug(
          `[${this.device.id}] MQTT cyclic write ${groupName} skipped: ${error && error.message ? error.message : error}`,
        );
      });
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.writeGroupTimers.set(groupName, timer);
  }

  _stopWriteGroupTimers() {
    for (const timer of this.writeGroupTimers.values()) {
      try { clearInterval(timer); } catch (_) {}
    }
    this.writeGroupTimers.clear();
  }

  _markWriteGroupsConnected() {
    this._initializeWriteGroupStates();
    for (const [groupName, state] of this.writeGroupStates.entries()) {
      const group = this._writeGroups()[groupName] || {};
      if (group.requireFreshCommandAfterReconnect !== false) state.requiresFreshCommand = true;
      state.lastSentAt = 0;
      state.staleLogged = false;
      state.blockLogged = false;
    }
    this._maybeSendPendingSafeValues().catch(() => {});
  }

  _markWriteGroupsDisconnected(reason) {
    for (const [groupName, state] of this.writeGroupStates.entries()) {
      const group = this._writeGroups()[groupName] || {};
      if (group.requireFreshCommandAfterReconnect !== false) state.requiresFreshCommand = true;
      state.lastSentAt = 0;
    }
    this._setControlTrackingStatus('offline', false, 0, Date.now()).catch(() => {});
    if (reason) this.adapter.log.debug(`[${this.device.id}] MQTT cyclic control paused: ${reason}`);
  }

  async _maybeSendPendingSafeValues() {
    if (!this.connected || !this.client) return;
    for (const [groupName, state] of this.writeGroupStates.entries()) {
      const group = this._writeGroups()[groupName] || {};
      if (!state.requiresFreshCommand || group.safeOnInitialConnect === false) continue;
      const intervalMs = this._groupRefreshIntervalMs(group) || 5000;
      if (state.lastSentAt > 0 && (Date.now() - state.lastSentAt) < intervalMs) continue;
      try {
        await this._publishWriteGroupValue(state, group, Number(group.safeValue || 0), 'safe_connect');
      } catch (_) {
        // Retained API/capability messages may not have arrived yet. The cyclic
        // timer retries without flooding the warning log.
      }
    }
  }

  async _sendSafeWriteGroupsOnDisconnect() {
    for (const [groupName, state] of this.writeGroupStates.entries()) {
      const group = this._writeGroups()[groupName] || {};
      if (group.safeOnDisconnect !== true) continue;
      try {
        await this._publishWriteGroupValue(state, group, Number(group.safeValue || 0), 'safe_disconnect');
      } catch (_) {
        // A best-effort 0 W command is useful on a controlled shutdown, but a
        // broken MQTT link must never block adapter termination.
      }
    }
  }

  async _refreshWriteGroup(groupName, reason) {
    const state = this.writeGroupStates.get(groupName);
    const group = this._writeGroups()[groupName];
    if (!state || !group || !this.connected || !this.client || state.refreshBusy) return;

    state.refreshBusy = true;
    try {
      const safeValue = Number.isFinite(Number(group.safeValue)) ? Number(group.safeValue) : 0;
      if (state.requiresFreshCommand) {
        await this._publishWriteGroupValue(state, group, safeValue, 'safe_reconnect');
        return;
      }

      const freshnessMs = this._groupCommandFreshnessMs(group);
      const commandAge = state.lastExternalWriteAt > 0 ? (Date.now() - state.lastExternalWriteAt) : Number.POSITIVE_INFINITY;
      if (freshnessMs > 0 && commandAge > freshnessMs) {
        if (!state.staleLogged) {
          state.staleLogged = true;
          this.adapter.log.warn(
            `[${this.device.id}] MQTT control setpoint is stale (${Math.round(commandAge)} ms); sending safe ${safeValue} W`,
          );
        }
        await this._publishWriteGroupValue(state, group, safeValue, 'safe_stale');
        return;
      }

      state.staleLogged = false;
      try {
        await this._publishWriteGroupValue(state, group, state.requestedValue, reason || 'refresh');
        state.blockLogged = false;
      } catch (error) {
        if (!state.blockLogged) {
          state.blockLogged = true;
          this.adapter.log.warn(
            `[${this.device.id}] MQTT cyclic control blocked; sending safe ${safeValue} W: ${error && error.message ? error.message : error}`,
          );
        }
        if (group.safeOnValidationFailure !== false) {
          await this._publishWriteGroupValue(state, group, safeValue, 'safe_blocked');
        }
      }
    } finally {
      state.refreshBusy = false;
    }
  }

  async _publishWriteGroupValue(state, group, requestedValue, origin) {
    if (!state || !state.dp) throw new Error('Missing MQTT write-group command datapoint');
    if (!this.connected || !this.client) throw new Error('MQTT not connected');

    let effectiveValue = requestedValue;
    if (String((this.hints.powerControl || {}).dpId || '') === String(state.dp.id || '')) {
      effectiveValue = this._normalizePowerCommand(state.dp, requestedValue);
    }
    this.commandCache.set(String(state.dp.id), effectiveValue);

    const payloadObject = this._buildWriteGroupPayload(state.dp, effectiveValue, group);
    const source = state.dp.source || {};
    const topic = String(group.topic || source.topic || '');
    if (!topic) throw new Error(`Missing MQTT write-group topic for ${state.groupName}`);
    const qos = Number.isFinite(Number(group.qos)) ? Math.max(0, Math.min(2, Number(group.qos))) : 0;
    const retain = group.retain === true;
    await this._publish(topic, JSON.stringify(payloadObject), { qos, retain }, true);

    const now = Date.now();
    const commandChanged = !sameStateValue(state.lastSentValue, effectiveValue);
    state.effectiveValue = effectiveValue;
    state.lastSentAt = now;
    state.lastSentValue = effectiveValue;
    if (commandChanged || !state.lastCommandChangedAt) state.lastCommandChangedAt = now;
    await this._recordControlCommand(effectiveValue, now, origin || 'external', commandChanged);

    return { effectiveValue, topic, payload: payloadObject };
  }

  _controlStatusDp(configKey) {
    const id = String((this.hints.powerControl || {})[configKey] || '');
    return id ? this.dpById.get(id) || null : null;
  }

  async _setControlTrackingValue(configKey, value, timestamp) {
    const dp = this._controlStatusDp(configKey);
    if (!dp) return false;
    return this._setDatapointValue(dp, value, timestamp || Date.now(), { markFresh: true });
  }

  async _setControlTrackingStatus(status, ok, errorW, timestamp) {
    let changes = 0;
    if (await this._setControlTrackingValue('trackingStatusDpId', String(status), timestamp)) changes += 1;
    if (await this._setControlTrackingValue('trackingOkDpId', !!ok, timestamp)) changes += 1;
    if (await this._setControlTrackingValue('trackingErrorDpId', Number.isFinite(Number(errorW)) ? Number(errorW) : 0, timestamp)) changes += 1;
    return changes;
  }

  async _recordControlCommand(effectiveValue, timestamp, origin, commandChanged) {
    let changes = 0;
    if (await this._setControlTrackingValue('commandedPowerDpId', Number(effectiveValue), timestamp)) changes += 1;
    if (await this._setControlTrackingValue('lastSentMsDpId', Number(timestamp), timestamp)) changes += 1;
    const safeOrigin = String(origin || '').startsWith('safe_');
    if (safeOrigin) {
      changes += await this._setControlTrackingStatus(String(origin), false, 0, timestamp);
    } else if (commandChanged) {
      changes += await this._setControlTrackingStatus('pending', false, 0, timestamp);
    }
    return changes;
  }

  _activePowerWriteGroupState() {
    const dpId = String((this.hints.powerControl || {}).dpId || '');
    for (const state of this.writeGroupStates.values()) {
      if (state && state.dp && String(state.dp.id) === dpId) return state;
    }
    return null;
  }

  async _evaluateControlTracking(now) {
    const config = this.hints.powerControl || {};
    const measurementDpId = String(config.measurementDpId || '');
    if (!measurementDpId) return 0;
    const state = this._activePowerWriteGroupState();
    if (!state || !state.lastSentAt) return this._setControlTrackingStatus('idle', false, 0, now);

    const measurementFreshnessMs = this._telemetryFreshnessMs(Number(config.measurementFreshnessMs || 5000));
    if (!this._isFresh(measurementDpId, measurementFreshnessMs)) {
      return this._setControlTrackingStatus('measurement_stale', false, 0, now);
    }

    const measured = Number(this.valueCache[measurementDpId]);
    const commanded = Number(state.lastSentValue);
    if (!Number.isFinite(measured) || !Number.isFinite(commanded)) {
      return this._setControlTrackingStatus('measurement_invalid', false, 0, now);
    }

    const errorW = measured - commanded;
    await this._setControlTrackingValue('trackingErrorDpId', errorW, now);
    const delayMs = this._trackingDelayMs(Number(config.trackingDelayMs || 3000));
    const commandChangedAt = Number(state.lastCommandChangedAt || state.lastSentAt || 0);
    if ((now - commandChangedAt) < delayMs) {
      return this._setControlTrackingStatus('pending', false, errorW, now);
    }

    const fixedTolerance = Math.max(0, Number(config.trackingToleranceW || 500));
    const percentageTolerance = Math.max(0, Number(config.trackingTolerancePct || 10));
    const tolerance = Math.max(fixedTolerance, Math.abs(commanded) * percentageTolerance / 100);
    const following = Math.abs(errorW) <= tolerance;
    return this._setControlTrackingStatus(following ? 'following' : 'deviating', following, errorW, now);
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
    const inverterStateFreshnessMs = this._telemetryFreshnessMs(Number(config.inverterStateFreshnessMs || 5000));
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
    const stateFreshnessMs = this._telemetryFreshnessMs(Number(config.stateFreshnessMs || 5000));
    if (batteryStateDpId) {
      if (!this._isFresh(batteryStateDpId, stateFreshnessMs)) {
        throw new Error(`TESVOLT battery state is stale or missing (>${stateFreshnessMs} ms)`);
      }
      const state = String(this.valueCache[batteryStateDpId] || '');
      if (!allowedBatteryStates.includes(state)) {
        throw new Error(`TESVOLT battery state ${state || 'unknown'} does not allow a non-zero power command`);
      }
    }

    const limitsFreshnessMs = this._telemetryFreshnessMs(Number(config.limitsFreshnessMs || 5000));
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
      const writeGroups = this._writeGroups();
      const group = writeGroups[writeGroupName];
      if (!group) throw new Error(`Unknown MQTT write group: ${writeGroupName}`);

      this._initializeWriteGroupStates();
      let state = this.writeGroupStates.get(writeGroupName);
      if (!state) {
        state = {
          groupName: writeGroupName,
          dp,
          requestedValue: value,
          effectiveValue: value,
          lastExternalWriteAt: 0,
          lastSentAt: 0,
          lastSentValue: null,
          lastCommandChangedAt: 0,
          requiresFreshCommand: false,
          refreshBusy: false,
          staleLogged: false,
          blockLogged: false,
        };
        this.writeGroupStates.set(writeGroupName, state);
      }
      state.dp = dp;

      // Publish first. Only a successfully transmitted external command becomes
      // the command that the cyclic refresh loop is allowed to keep alive.
      const result = await this._publishWriteGroupValue(state, group, value, 'external');
      state.requestedValue = value;
      state.effectiveValue = result.effectiveValue;
      state.lastExternalWriteAt = Date.now();
      state.requiresFreshCommand = false;
      state.staleLogged = false;
      state.blockLogged = false;
      this._scheduleWriteGroupRefresh(writeGroupName, group, state);
      return result;
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
