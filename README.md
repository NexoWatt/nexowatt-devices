# nexowatt-devices (ioBroker Adapter)


Unterstützte Protokolle (Stand Prototyp 0.1.0):

- **Modbus TCP**
- **Modbus RTU (Serial)**
- **MQTT** (event‑basiert)
- **HTTP/JSON** (Polling)



---

## 1) Installation (lokal)

1. Ordner `iobroker.nexowatt-devices` nach `.../iobroker/node_modules/` kopieren
2. In den Adapter‑Ordner wechseln und Dependencies installieren:
   ```bash
   cd /opt/iobroker/node_modules/iobroker.nexowatt-devices
   npm install
   ```
3. Adapter hochladen:
   ```bash
   iobroker upload nexowatt-devices
   ```
4. In ioBroker Admin eine Instanz anlegen und konfigurieren.

### Modbus RTU Hinweis
`modbus-serial` nutzt unter Linux i.d.R. `serialport` (native build). Auf Raspberry Pi & Co. brauchst du ggf. Build‑Tools (`build-essential`, `python3`, etc.).

---

## 2) Admin‑Konzept (Kategorien → Hersteller → Treiber)

Im Admin kannst du Geräte hinzufügen:

- **Kategorie** (z.B. EVCS, METER, BATTERY, HEAT …)
- **Hersteller**
- **Protokoll** (Modbus TCP / Modbus RTU / MQTT / HTTP)
- Verbindungseinstellungen je Protokoll

Die Datenpunkte des Templates werden im Modal unten als Tabelle angezeigt.

---

## 3) Objektstruktur in ioBroker

Für jedes Gerät `<id>`:

- `nexowatt-devices.0.devices.<id>.info.connection`
- `nexowatt-devices.0.devices.<id>.info.lastError`
- `nexowatt-devices.0.devices.<id>.<datapointId>`

Schreibbare Datenpunkte werden als `write=true` angelegt. Wenn du einen State änderst (ack=false), schreibt der Adapter über das passende Protokoll.

---

## 4) Geräte‑Konfiguration (devicesJson)

Die Geräte werden intern als JSON gespeichert. Beispiel:

```json
[
  {
    "id": "evcs_garage",
    "name": "Wallbox Garage",
    "enabled": true,
    "category": "EVCS",
    "manufacturer": "goe",
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

## 5) Grenzen / Erwartungsmanagement

- Für 64‑bit Werte (uint64/int64) kann es bei sehr großen Zählern zu **Precision‑Limits** kommen. Der Adapter gibt dann ggf. Strings zurück.

---

## 6) Weiterer Ausbau (Roadmap‑fähig)

Wenn du willst, kann ich im nächsten Schritt:

1. **Treiber‑UI** weiter ausbauen (echte Hersteller‑Reiter, Filter, Suchfeld, Datenpunkt‑Override im UI)
3. Optimierung: Modbus‑Batching, Retry‑Strategien, per‑Datapoint Quality‑Flags

---

## Lizenz
MIT (Prototyp).