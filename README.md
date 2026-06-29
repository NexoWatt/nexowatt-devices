# nexowatt-devices (ioBroker Adapter)

**nexowatt-devices** ist ein eigenständiger Multi‑Protokoll‑Geräteadapter für ioBroker.
Er bietet eine **Kategorien → Hersteller → Treiber/Template**‑Konfiguration und erzeugt die
zugehörigen Datenpunkte automatisch in ioBroker.

Unterstützte Protokolle:

- **Modbus TCP**
- **Modbus RTU (Serial)**
- **MQTT** (event‑basiert)
- **HTTP/JSON** (Polling)
- **UDP** (Text-Command/JSON, z.B. KEBA KeContact)

---

## Lizenz

Dieses Projekt ist **proprietär** lizenziert und darf nur gemäß der Datei `LICENSE`
verwendet werden. Drittanbieter-Komponenten unterliegen ihren jeweiligen Lizenzen
(siehe `THIRD_PARTY_NOTICES.md`).

---

## 1) Installation aus GitHub (empfohlen)

Dieser Adapter ist **nicht** im offiziellen ioBroker‑Repository. Daher funktioniert `iobroker add ...` nicht.

Installiere ihn aus GitHub per `iobroker url` (Tarball):

```bash
# Beispiel (ersetze USER/REPO/BRANCH):
iobroker url https://github.com/USER/ioBroker.nexowatt-devices/tarball/main
```

Danach kannst du im Admin wie gewohnt eine Instanz anlegen.

### Hinweis: Admin‑Fehler „adminUI ist string“
Falls in deiner Installation alte Adapter‑Objekte existieren, bei denen `common.adminUI` fälschlich als String gespeichert ist (z.B. `"materialize"`),
kann der Admin beim Laden eine Exception werfen. Der Adapter enthält eine **automatische Migration**,
die solche Objekte beim Start in das neue Format konvertiert (`{ config: "materialize" }`).

---

## 2) Installation lokal (Alternative)

1. Repository/Ordner nach `/opt/iobroker/node_modules/iobroker.nexowatt-devices` kopieren
2. Dependencies installieren:
   ```bash
   cd /opt/iobroker/node_modules/iobroker.nexowatt-devices
   npm install --omit=dev
   ```
3. Admin‑Dateien hochladen:
   ```bash
   iobroker upload nexowatt-devices
   ```
4. Instanz im Admin anlegen.

---

## 3) Admin‑Konzept (Kategorien → Hersteller → Treiber)

Im Admin kannst du Geräte hinzufügen:

- **Kategorie** (z.B. EVCS, METER, BATTERY, HEAT …)
- **Hersteller**
- **Treiber/Template** (liefert Datenpunkte + Default‑Protokolle)
- **Protokoll** (Modbus TCP / Modbus RTU / MQTT / HTTP)
- Verbindungseinstellungen je Protokoll (z.B. IP/Port/Unit‑ID)

Die Datenpunkte des Templates werden im Modal unten als Tabelle angezeigt.

### RS485 / Modbus RTU auf ED-IPC3020

Auf der ED-IPC3020-Hardware ist die RS485-Schnittstelle typischerweise als **/dev/com2** verfügbar (COM2).
Trage diesen Pfad bei **Modbus RTU → Serial Port** ein und achte darauf, dass der ioBroker-User Zugriff auf das Gerät hat (z.B. Gruppe `dialout`).

---

## 4) Objektstruktur in ioBroker

Für jedes Gerät `<id>`:

- `nexowatt-devices.0.devices.<id>.info.connection`
- `nexowatt-devices.0.devices.<id>.info.lastError`
- `nexowatt-devices.0.devices.<id>.<datapointId>`

Zusätzlich erzeugt der Adapter (best‑effort) eine **stabile Alias‑API** unter:

- `nexowatt-devices.0.devices.<id>.aliases.*`

Schreibbare Datenpunkte werden als `write=true` angelegt. Wenn du einen State änderst (`ack=false`),
schreibt der Adapter über das passende Protokoll.

---

## 4a) Aliases (stabile Namen für andere Adapter)

Damit nachgelagerte Adapter/Logiken (z.B. Steuer‑ oder Benachrichtigungsadapter) **nicht**
für jeden Hersteller unterschiedliche Datenpunkt‑IDs kennen müssen, legt der Adapter
pro Gerät eine Alias‑Struktur unter `devices.<id>.aliases` an.

Diese Alias‑States sind bewusst **kategorienübergreifend ähnlich** und werden – sofern ein
passender Datenpunkt im Template vorhanden ist – automatisch erstellt.

### Standard (alle Geräte)

- `aliases.comm.connected` (bool) – Kommunikationsstatus zum Gerät
- `aliases.comm.lastError` (string) – letzter Kommunikationsfehler
- `aliases.alarm.offline` (bool) – `true`, wenn das Gerät nicht erreichbar ist

### PV_INVERTER (Wechselrichter)

Lesen:

- `aliases.r.power` (W) – aktuelle Wirkleistung
- `aliases.r.energyTotal` (Wh) – Gesamtertrag/Energiezähler
- `aliases.r.statusCode` (number) – Statuscode (vendor‑spezifisch, aber stabiler Ort)
- `aliases.r.gridConnectionState` (number) – Netzstatus roh (falls verfügbar)
- `aliases.r.gridConnected` (bool) – Netz verbunden (best‑effort Berechnung)

Steuern (falls Template/WR unterstützt):

- `aliases.ctrl.run` (bool) – Start/Stop bzw. Connect/Disconnect (Template‑abhängig)
- `aliases.ctrl.powerLimitPct` (number, %) – Wirkleistungsbegrenzung in %
- `aliases.ctrl.powerLimitEnable` (bool) – Begrenzung aktivieren (falls vorhanden)

Alarme/Benachrichtigungen (best‑effort):

- `aliases.alarm.fault` (bool) – Fehler aktiv
- `aliases.alarm.warning` (bool) – Warnung aktiv

> Hinweis: Einige Geräte liefern Setpoints nur **write‑only**. In diesem Fall bleibt
> `aliases.ctrl.powerLimitPct` auf dem **zuletzt geschriebenen Wert**, bis das Gerät
> einen lesbaren Feedback‑Registerwert bereitstellt.


### METER (Zähler)

Lesen (best‑effort, je nach Template verfügbar):

- `aliases.r.power` (W) – Netto‑Wirkleistung (Import positiv / Export negativ oder berechnet)
- `aliases.r.powerImport` (W) – Importleistung (Bezug)
- `aliases.r.powerExport` (W) – Exportleistung (Einspeisung)
- `aliases.r.energyImport` (Wh) – Importenergie (Bezug)
- `aliases.r.energyExport` (Wh) – Exportenergie (Einspeisung)
- `aliases.r.voltageL1/L2/L3` (V) – Spannung je Phase (bei 1‑phasigen Zählern i.d.R. nur L1)
- `aliases.r.currentL1/L2/L3` (A) – Strom je Phase (bei 1‑phasigen Zählern i.d.R. nur L1)
- `aliases.r.frequency` (Hz) – Netzfrequenz

### EVCS / EVSE / CHARGER (Ladestationen / Wallboxen)

Lesen (best‑effort, je nach Template verfügbar):

- `aliases.r.power` (W) – aktuelle Ladeleistung
- `aliases.r.energySession` (Wh/kWh) – Energie in der aktuellen Sitzung
- `aliases.r.energyTotal` (Wh/kWh) – Gesamtenergie (falls verfügbar)
- `aliases.r.statusCode` (number) – Statuscode (herstellerabhängig, aber stabiler Ort)
- `aliases.r.errorCode` (number) – Fehlercode (falls verfügbar)

Steuern (falls Template/Ladestation unterstützt):

- `aliases.ctrl.run` (bool) – Laden aktivieren/stoppen (Enable/Start)
- `aliases.ctrl.currentLimitA` (A) – Stromlimit (A; bei Geräten mit mA‑Registern erfolgt die Umrechnung automatisch)
- `aliases.ctrl.powerLimitW` (W) – Leistungsbegrenzung (W; sofern unterstützt)
- `aliases.ctrl.unlockPlug` (bool) – Stecker entriegeln (sofern unterstützt)

Alarme/Benachrichtigungen (best‑effort):

- `aliases.alarm.fault` (bool) – Fehler aktiv (z.B. `errorCode != 0`)

### BATTERY / ESS / BATTERY_INVERTER (Batteriesysteme)

Lesen (best‑effort, je nach Template verfügbar):

- `aliases.r.soc` (%) – State of Charge
- `aliases.r.soh` (%) – State of Health (falls vorhanden)
- `aliases.r.voltage` (V) – Batteriespannung
- `aliases.r.current` (A) – Batteriestrom
- `aliases.r.temperature` (°C) – Batterietemperatur (falls vorhanden)
- `aliases.r.power` (W) – Batterieleistung netto (**Konvention:** Entladen positiv, Laden negativ; best‑effort)
- `aliases.r.powerCharge` (W) – Ladeleistung (absolut, ≥0)
- `aliases.r.powerDischarge` (W) – Entladeleistung (absolut, ≥0)
- `aliases.r.energyCharge` (Wh) – Ladeenergie gesamt (falls vorhanden)
- `aliases.r.energyDischarge` (Wh) – Entladeenergie gesamt (falls vorhanden)
- `aliases.r.allowCharge` (bool) – BMS erlaubt Laden (falls vorhanden)
- `aliases.r.allowDischarge` (bool) – BMS erlaubt Entladen (falls vorhanden)
- `aliases.r.allowedChargePower` (W) – erlaubte Ladeleistung (falls vorhanden)
- `aliases.r.allowedDischargePower` (W) – erlaubte Entladeleistung (falls vorhanden)

Steuern (falls Template/Batteriesystem unterstützt):

- `aliases.ctrl.powerSetpointW` (W) – Wirkleistungs-Setpoint (batterieseitig/ESS, herstellerabhängige Semantik)
- `aliases.ctrl.powerSetpointL1/L2/L3` (W) – Setpoints je Phase (falls vorhanden)
- `aliases.ctrl.controlMode` (number) – Control Mode (vendor-spezifisch; stabiler Ort)
- `aliases.ctrl.chargeEnable` (bool) – Laden erlauben/sperren (falls vorhanden; z.B. Victron → DISABLE-Flag invertiert)

Alarme/Benachrichtigungen (best‑effort, konservativ):

- `aliases.alarm.fault` (bool) – Fehler aktiv (z.B. Error-Codes oder Alarm/Protect-Flag-Register ≠ 0)
- `aliases.alarm.warning` (bool) – Warnung aktiv (falls passende Warn-Register vorhanden)

---

## 4b) SMA PV‑Wechselrichter (Modbus) – Templates & wichtige Datenpunkte

Im Adapter sind (u.a.) folgende **PV_INVERTER**‑Templates integriert:

- **SMA STP125‑70 (SunSpec Modbus) – Minimal**
  - `templateId`: `pv_inverter.sma.SmaStp12570SunSpecMinimal`
  - **Lesen (wichtig):**
    - `W` (aktuelle Wirkleistung, W)
    - `WH` (Energiezähler, Wh)
    - `St` (Betriebszustand / Operating State)
    - `PVConn` (PV‑Netzverbindung)
    - `Evt1` (Event‑Flags – für Fehler/Warnungen)
  - **Steuern (wichtig):**
    - `Conn` (Verbinden/Trennen, bool)
    - `WMaxLim_Ena` (Leistungsbegrenzung aktiv, bool)
    - `WMaxLimPct` (Leistungsbegrenzung in %, 0…100)
  - **Wechselrichter‑Ausfall / Benachrichtigungen:**
    - Alias (empfohlen):
      - Offline: `...aliases.alarm.offline=true`
      - Fault: `...aliases.alarm.fault=true`
    - Rohdaten (optional): `St` und `Evt1` (z.B. `St==7` → Fault; `Evt1!=0` → Ereignis)

- **SMA Sunny Tripower X (SMA Modbus) – Minimal**
  - `templateId`: `pv_inverter.sma.SmaSunnyTripowerXMinimal`
  - **Lesen (wichtig):**
    - `W` (aktuelle Wirkleistung, W)
    - `TotWhOut` (Gesamtertrag, Wh)
    - `Health` (Zustand: `35=Fehler`, `303=Aus`, `307=Ok`, `455=Warnung`)
    - `PvGriConn` (Netzanbindung der Anlage)
  - **Steuern (wichtig):**
    - `OpMod` (Allgemeine Betriebsart: `381=Stopp`, `1467=Start`)
    - `WLimPct` (Wirkleistungsbegrenzung über Anlagensteuerung in %, write‑only)
  - **Wechselrichter‑Ausfall / Benachrichtigungen:**
    - Alias (empfohlen):
      - Offline: `...aliases.alarm.offline=true`
      - Fault: `...aliases.alarm.fault=true`
      - Warning: `...aliases.alarm.warning=true`
    - Rohdaten (optional): `Health==35` (Fehler) bzw. `Health==455` (Warnung)

## 4c) Sungrow Modbus – Templates & wichtige Datenpunkte

Der Adapter enthält zusätzliche Sungrow-Templates für direkte Wechselrichter-Kommunikation und für System-Gateways:

- **Sungrow Grid-Connected CX/RS/RT (Modbus)**
  - `templateId`: `pv_inverter.sungrow.GridConnectedCxRsRtModbus`
  - Kategorie: `PV_INVERTER`
  - Wichtig: `W` (Wirkleistung), `pV_POWER` (PV/DC-Leistung), `TotWhOut` (Gesamtertrag), `St` (Betriebszustand), `Evt1` (Fehlercode), `WMaxLim_Ena`, `WMaxLimPct`, `WMaxLim`
  - Schreiblogik: Beim Schreiben von `WMaxLimPct` oder `WMaxLim` wird der Sungrow-Leistungsbegrenzungs-Schalter automatisch aktiviert.

- **Sungrow Residential Hybrid V1.1.9 (Modbus)**
  - `templateId`: `ess.sungrow.ResidentialHybridV119`
  - Kategorie: `ESS`
  - Wichtig: `pV_POWER`, `W`, `gRID_POWER`, `lOAD_POWER`, `bATTERY_POWER`, `Soc`, Energiewerte, Fehler-Bitfelder, Firmware-Versionen
  - Steuerung: `aliases.ctrl.powerSetpointW` schreibt als signierter Leistungs-Sollwert: positiv = Entladen, negativ = Laden, `0` = Stop. Der Adapter setzt dabei automatisch EMS-/Betriebsmodus, Lade-/Entlade-Kommando und Leistungsregister.

- **Sungrow Logger1000/3000/4000 (Modbus)**
  - `templateId`: `ess.sungrow.Logger1000_3000_4000`
  - Kategorie: `ESS`, Default Unit-ID: `247`
  - System-/Array-Daten inkl. PV-/Netz-/Last-/Batterie-Leistung sowie Schreibwerte für EMS, Laden/Entladen, Einspeisebegrenzung und PV-Leistungsbegrenzung.

- **Sungrow iHomeManager V1.0.1 (Modbus)**
  - `templateId`: `ess.sungrow.iHomeManagerV101`
  - Kategorie: `ESS`, Default Unit-ID: `247`
  - Systemweite EMS-Daten und Steuerung; keine Einzelwechselrichter-Weiterleitung über iHomeManager.

Hinweis: Die Sungrow-Dokumentation verwendet 1-basierte Registeradressen; die Templates sind bereits mit den tatsächlich zu sendenden Modbus-Adressen (`Register - 1`) hinterlegt.

Stabilitäts-Hinweis ab `0.5.93`: Das Residential-Hybrid-Template pollt standardmäßig nur die stabilen Live-/Kernregister schnell und verschiebt optionale, modell-/Gateway-abhängige Register in einen reduzierten Slow-Poll. Kurze Modbus-Unterbrechungen setzen Daten-Aliase wie `aliases.r.soc` nicht mehr auf `null`; der Verbindungsstatus wird weiterhin über `aliases.comm.connected`, `aliases.comm.lastError` und `aliases.alarm.offline` aktualisiert.


## 4d) MENNEKES AMTRON 4You 500 / 4Business 700 Modbus TCP

Neu integriert ist ein vollständiges Modbus-TCP-Template für die MENNEKES AMTRON 4You 500 / 4Business 700 Serie:

- `templateId`: `evcs.mennekes.amtron4you500.4business700.modbusTcp`
- Kategorie: `EVCS`
- Modbus TCP Port: `502`
- Unit-ID Default: `1`
- Registertyp: Holding Register / FC03 für Lesen, FC06 bzw. FC16 für Schreiben

Wichtige Lese-Datenpunkte:

- Status: `cHARGE_POINT_STATE`, `vEHICLE_STATE`, `cHARGE_POINT_AVAILABILITY`, `rELAY_STATE`, `pLUG_LOCK_STATUS`
- Fehler: `eRROR_CODE`, `eRROR_CODE_2`, `eRROR_CODE_3`, `eRROR_CODE_4`
- Messwerte: `aCTIVE_POWER`, `aCTIVE_PRODUCTION_ENERGY`, `mETER_POWER_L1..L3`, `cURRENT_L1..L3`, `vOLTAGE_L1..L3`
- Ladesession: `eNERGY_SESSION`, `cHARGING_DURATION`, `cHARGING_START_TIME`, `cHARGING_END_TIME`, `sIGNALED_CURRENT_TO_EV`
- HEMS/Phasen: `hEMS_CONFIGURATION`, `hEMS_COMMUNICATION_STATUS`, `hEMS_POWER_LIMIT_MINIMUM`, `hEMS_POWER_LIMIT_MAXIMUM`, `pHASE_SWITCH_MODE`, `aSSIGNED_PHASES`
- Charging-Point-Network: `cHARGING_POINT_NETWORK_*`

Wichtige Schreib-Datenpunkte und Aliases:

- `sET_CHARGING_CURRENT` bzw. Alias `aliases.ctrl.currentLimitA` – HEMS-Stromlimit in A, intern über das 0,1-A-Register
- `eV_SET_CHARGE_POWER_LIMIT` bzw. Alias `aliases.ctrl.powerLimitW` – HEMS-Leistungslimit in W
- `sAFE_CURRENT` bzw. Alias `aliases.ctrl.safeCurrentA` – Fallback-Strom bei HEMS-Kommunikationsverlust
- `cOMMUNICATION_TIMEOUT` bzw. Alias `aliases.ctrl.communicationTimeoutS` – HEMS-Kommunikationstimeout in Sekunden
- `cHARGING_POINT_NETWORK_EMS_CURRENT_LIMIT` bzw. Alias `aliases.ctrl.networkCurrentLimitA` – schreibt automatisch L1/L2/L3 gemeinsam per FC16

Hinweis: Für HEMS-Steuerung muss die Wallbox-seitige Modbus-TCP-/HEMS-Konfiguration auf Read/Write stehen (`hEMS_CONFIGURATION == 2`).

Stabilitäts-Hinweis ab `0.5.94`: Das AMTRON-Template pollt Live-/Kernregister schnell und verschiebt Firmware-/Info-/Netzwerk-Zusatzregister in einen langsamen 5-Minuten-Poll. Zusätzlich setzt der Modbus-Treiber harte Operation-/Connect-Timeouts, schließt hängende TCP-Sockets aktiv und baut die Verbindung nach Timeouts sauber neu auf. Bereits geschriebene HEMS-Sollwerte werden periodisch aufgefrischt, damit die Wallbox nicht wegen auslaufender HEMS-Kommunikation in den Safe-Current-Fallback fällt.


## 4e) Alfen NG9xx / ACE Modbus TCP

Für Alfen NG9xx / ACE sind drei getrennte Modbus-TCP-Templates enthalten, weil Alfen je Registergruppe feste Modbus-Serveradressen/Unit-IDs verwendet:

- `evcs.alfen.ng9xx.ace.socket1.modbusTcp` – Socket 1, Unit-ID `1`
- `evcs.alfen.ng9xx.ace.socket2.modbusTcp` – Socket 2, Unit-ID `2`
- `evcs.alfen.ng9xx.ace.station.modbusTcp` – Safe-Default-Mischtemplate: Socket-1-Livewerte über Unit-ID `1`; Station/SCN-Datenpunkte bleiben vorhanden, werden aber nicht mehr automatisch gepollt/beschrieben, wenn SCN nicht aktiv ist

Wichtige Lese-Datenpunkte:

- Socket: Messwerte `vOLTAGE_*`, `cURRENT_*`, `aCTIVE_POWER`, Energiezähler, `eVSE_STATE`, `mODE3_STATE`, `aCTUAL_APPLIED_MAX_CURRENT`, `mODBUS_MAX_CURRENT_VALID_TIME`
- Station/SCN: Produktdaten, Firmware, aktive Maximalströme, Temperatur, Anzahl Sockets, SCN-Verbrauch, SCN-Maximalströme und Valid-Time; diese Blöcke sind optional und bei vielen Einzel-Wallboxen im Socket-Modus nicht freigeschaltet

Wichtige Schreib-Datenpunkte:

- Socket: `sET_CHARGING_CURRENT` schreibt den Socket-Maximalstrom als kompletten 32-bit-Float per FC16.
- Socket: `cHARGE_USING_PHASES` akzeptiert nur `1` oder `3`.
- Station/SCN: `sCN_MAX_CURRENT_L1`, `sCN_MAX_CURRENT_L2`, `sCN_MAX_CURRENT_L3` schreiben die SCN-Phasenlimits als komplette 32-bit-Floats per FC16.

Fix ab `0.5.95`: Die Alfen-Templates verwenden jetzt direkt die tatsächlich zu sendenden Modbus-Protokolladressen (`Register - 1`). Zusätzlich erzwingt der Adapter die korrekte Unit-ID je Template und ignoriert alte manuelle Address-Offset-Werte für diese Alfen-Templates. Dadurch werden Schreibzugriffe nicht mehr um ein Register verschoben, was vorher bei Setpoint-Keepalive zu `Modbus exception 3: Illegal data value` führen konnte. Nicht-transportbedingte Write-Fehler markieren das Gerät außerdem nicht mehr fälschlich als offline.

Stabilitäts-/Kompatibilitätsfix ab `0.5.96`: Der Modbus-Treiber kann jetzt pro Datenpunkt/Registergruppe eine eigene Unit-ID verwenden. Das ist für Alfen wichtig, weil Socket-Werte auf Unit-ID `1`/`2` und Station/SCN-Werte auf Unit-ID `200` liegen. Das Station/SCN-Template enthält zusätzlich Socket-1-Livewerte als Fallback, damit Anlagen, die in ACE auf `TCP/IP EMS Control Mode = Socket` stehen und Unit-ID `200` ablehnen, trotzdem Leistung, Status, Energie und Socket-Stromlimit liefern. Alfen-Station/SCN-Blöcke werden nur noch langsam und optional gelesen; nicht unterstützte Blöcke erzeugen keinen Totalausfall der Socket-Werte.

Kompatibilitäts-/Watchdog-Fix ab `0.5.97`: Alfen-Socket-Reads werden je Datenpunkt isoliert, damit optionale oder vom eingebauten Zählertyp nicht gelieferte Register keine wichtigen Nachbarwerte wie Leistung, Mode-3-Status oder Stromlimit mitreißen. Zusätzlich gibt es stabile Aliase: `aliases.ctrl.run` / `aliases.ctrl.chargeEnable` geben die Ladung über `sET_CHARGING_CURRENT` frei (`true` = Standardstrom, `false` = `0 A`), `aliases.r.statusText`, `aliases.r.mode3State`, `aliases.r.vehicleConnected`, `aliases.r.charging`, `aliases.r.appliedCurrentLimitA`, `aliases.r.currentLimitValidTimeS`, `aliases.r.setpointAccountedFor` und `aliases.ctrl.phaseMode`. Alfen-Schreibwerte werden nach dem ersten Adapter-Schreibzugriff alle `10 s` erneuert, damit der Alfen-Watchdog/Validity-Timer nicht ausläuft.

Diagnose-Fix ab `0.5.98`: Wenn die Wallbox `sET_CHARGING_CURRENT` / Registerblock `1200..1215` mit `Illegal Data Address` ablehnt, weist der Adapter jetzt gezielt auf die Alfen-ACE-Einstellungen hin: Active Load Balancing/EMS aktivieren, TCP/IP EMS Control Mode auf Socket stellen, Sockets aktivieren und Schreiben der Maximalströme erlauben. Nicht unterstützte U64-Sentinelwerte werden als `null` behandelt, damit keine ioBroker-Typwarnungen bei `uPTIME_MS` entstehen.

Fix ab `0.5.99`: Die Alfen-Templates sind jetzt auf einen sicheren Socket-Default gehärtet. Standardmäßig werden nur stabile Socket-Livewerte über Unit-ID `1` beziehungsweise `2` schnell gepollt. Station-/SCN-Blöcke auf Unit-ID `200` und der optionale Socket-Control-/Statusblock `1200..1215` werden nicht mehr automatisch als Pflichtwerte behandelt, weil viele Einzel-Wallboxen diese Bereiche erst nach passender ACE-/EMS-Konfiguration freigeben. Das gemischte Station-Template verwendet deshalb ebenfalls Socket-1-Livewerte und Socket-1-Steuerung als Safe Default. SCN-Datenpunkte bleiben im Template vorhanden, sind aber optional und werden nicht mehr per Default im Keepalive beschrieben. Der Alfen-Watchdog erneuert Socket-Schreibwerte alle `10 s`, aber erst nachdem dieser Datenpunkt tatsächlich erfolgreich geschrieben wurde. Bei `Illegal Data Address` / `Illegal Data Value` wird der betroffene Schreibpunkt für eine Stunde abgekühlt, damit die Wallbox nicht dauerhaft mit nicht freigegebenen Registern belastet wird.

Hinweis: Für Schreibzugriffe muss in ACE/Service Installer die Modbus-/EMS-Konfiguration passend aktiviert sein: Lesen erlauben, Schreiben der Maximalströme erlauben, Active Load Balancing/EMS-Modus aktivieren und die Validity-Time größer als das Poll-/Keepalive-Intervall setzen. Für normale Einzel-Wallboxen ist meistens das Socket-1-Template bzw. der Socket-Modus richtig; Station/SCN ist nur für die SCN-/Stationssteuerung gedacht.

### Hinweis zu Register‑Offsets
Viele Herstellerdokumentationen verwenden 1‑basierte Registeradressen (z.B. `40001`).
Wenn dein Gerät mit den im Template hinterlegten Adressen „um 1 daneben“ liegt, setze im Gerät:

- `addressOffset: -1`

### SunSpec Auto-Discovery (ab v0.5.6)

Bei **SunSpec-Modbus** Templates (z.B. **SMA STP125‑70**) versucht der Adapter beim Connect **automatisch** die
SunSpec-Signatur **`SunS`** zu finden und setzt intern einen passenden **Offset** (und bei Bedarf auch die **Unit-ID**).

Das hilft insbesondere bei Installationen, bei denen der SunSpec-Block nicht exakt bei `40000` beginnt (z.B. `39999` oder `0`).

Wenn du die Auto-Erkennung deaktivieren oder übersteuern willst, kannst du im Device-Connection-Block (best-effort) setzen:

- `autoSunSpec: false`
- `sunSpecTemplateBase: 40000` (nur wenn du ein anderes Template-Base-Layout verwendest)

---

## 5) Geräte‑Konfiguration (devicesJson)

Die Geräte werden intern als JSON gespeichert. Beispiel:

```json
[
  {
    "id": "evcs_garage",
    "name": "Wallbox Garage",
    "enabled": true,
    "category": "EVCS",
    "manufacturer": "go-e",
    "templateId": "evcs.goe.EvcsGoeModbusImpl",
    "protocol": "modbusTcp",
    "pollIntervalMs": 1000,
    "connection": {
      "host": "192.168.1.50",
      "port": 502,
      "unitId": 1,
      "timeoutMs": 2000,
      "addressOffset": 0
    }
  }
]
```

### Wichtige Felder
- `pollIntervalMs`: optional pro Gerät; sonst globales Polling
- `addressOffset`: um 1‑basierte Registerangaben (40001‑Style) zu korrigieren, z.B. `-1`

---

## Lizenz
MIT

### 0.5.99 - Alfen NG9xx/ACE profile hardening

- Alfen addresses re-audited against the ACE Modbus v1.0 table. The adapter keeps protocol addresses as `documentation register - 1`, as required by Alfen.
- Default Alfen polling now focuses on stable socket live meter values; optional Station/SCN UID200 blocks and the optional Socket control/status block are no longer default-critical.
- The mixed Station template is a safe Socket-1 default: Socket-1 live/control remains usable even when Station/SCN is not enabled in ACE.
- Socket write values are refreshed every 10 seconds after a successful user/script write.
- Added derived Alfen charging/status aliases from measured power and connection state when the optional Mode-3/status block is not exposed by the charger.
- Unsupported Alfen read/write attempts now cool down instead of being retried aggressively.



## MENNEKES AMTRON safety note (0.5.100)

The AMTRON HEMS watchdog is kept alive by regular Modbus polling. The adapter therefore no longer restores or periodically rewrites all writable MENNEKES HEMS/configuration registers on reconnect. Writable datapoints and aliases remain available.

### 0.5.100 - MENNEKES AMTRON HEMS watchdog/profile cleanup

MENNEKES AMTRON HEMS communication timeout is reset by regular Modbus read or write traffic. The AMTRON template therefore no longer performs a periodic write keepalive for all writable HEMS/network registers. On reconnect, only explicitly stored modern HEMS setpoints (`sET_CHARGING_CURRENT`, `eV_SET_CHARGE_POWER_LIMIT`) are restored. Configuration registers such as safe current, communication timeout and charging-point-network EMS limits are no longer auto-restored by default. Integer-only MENNEKES write registers are rounded before Modbus encoding so values such as `15.9 A` do not get sent to whole-ampere registers.



### Version 0.5.100

- MENNEKES AMTRON HEMS restore/keepalive hardened: the adapter no longer performs cyclic writes for Mennekes setpoints, because regular Modbus reads already reset the HEMS communication timeout. On reconnect it restores only the last explicitly written current/power control setpoint and no longer rewrites safe-current, communication-timeout, deprecated legacy, or network registers automatically.

### Alfen NG9xx / ACE Modbus note

The Alfen ACE template uses the protocol addresses required by the Alfen documentation: document register minus 1, fixed Unit-ID 1 for socket 1, Unit-ID 2 for socket 2, and Unit-ID 200 for station/SCN. The socket EMS control block around document registers 1200..1215 is optional in practice and is only writable when Active Load Balancing / Energy Management System mode, Socket control, Enable sockets, and Allow writing maximum currents are enabled in ACE Service Installer. The adapter does not perform unsafe off-by-one write fallback for these control registers.

### Version 0.5.101

- Alfen NG9xx / ACE Modbus hardening: removed the unsafe off-by-one fallback for Alfen read/write operations. The adapter now keeps the documented protocol addressing only (`documentation register - 1`) and will no longer retry `sET_CHARGING_CURRENT` on the shifted address `1210` when the correct address `1209` is rejected.
- Alfen maximum-current setpoints are rounded to whole amperes before encoding because the Alfen table specifies a `1 A` step size for `FLOAT32` maximum-current registers. Values such as `13.3 A` are sent as `13 A`, while the 10-second watchdog refresh remains active after a successful write.

### 0.5.102 - Alfen ACE write/address hardening

- Fixes a crash in alias write error handling (`Cannot access dp before initialization`).
- Forces Alfen ACE templates to use protocol address offset `0` even when stale device/global settings contain an address offset.
- Disables unsafe off-by-one write retries for Alfen 32-bit control registers.
- Keeps unexpected state-change errors from terminating the adapter instance.

