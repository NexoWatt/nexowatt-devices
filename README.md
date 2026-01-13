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

Schreibbare Datenpunkte werden als `write=true` angelegt. Wenn du einen State änderst (`ack=false`),
schreibt der Adapter über das passende Protokoll.

---

## 4a) SMA PV‑Wechselrichter (Modbus) – Templates & wichtige Datenpunkte

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
    - Kommunikationsausfall: `...info.connection=false`
    - Betriebs-/Fehlerzustand: `St` und `Evt1` (z.B. `St==7` → Fault; `Evt1!=0` → Ereignis)

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
    - Kommunikationsausfall: `...info.connection=false`
    - Zustand/Fault: `Health==35` (Fehler) bzw. `Health==455` (Warnung)

### Hinweis zu Register‑Offsets
Viele Herstellerdokumentationen verwenden 1‑basierte Registeradressen (z.B. `40001`).
Wenn dein Gerät mit den im Template hinterlegten Adressen „um 1 daneben“ liegt, setze im Gerät:

- `addressOffset: -1`

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