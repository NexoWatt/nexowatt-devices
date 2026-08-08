# TESVOLT IoT Gateway – MQTT EMS Interface V2 (0.5.150)

## Ziel und Abgrenzung

Version 0.5.150 ergänzt das neue Template:

```text
ess.tesvolt.iotGateway.mqttV2
```

Die Integration ist **additiv**. Das bestehende TESVOLT-Modbus-Template
`ess.tesvolt.TesvoltEnergyManagerVermarkter` bleibt unverändert und wird nicht
migriert oder ersetzt.

Grundlage ist die TESVOLT-Spezifikation **„EMS-Interface (MQTT) – V2“**. Das
TESVOLT IoT Gateway stellt den MQTT-Broker bereit; NexoWatt EOS verbindet sich
als Third-Party-EMS. Die API-Version wird über `EMS/APIVersion` ermittelt und
für diese Implementierung muss `V2` gemeldet werden.

## Verbindung

Im Geräte-Dialog:

```text
Kategorie:  Batteriespeicher / ESS
Hersteller: TESVOLT
Template:   TESVOLT IoT Gateway (MQTT EMS Interface V2)
Protokoll:  mqtt
URL:        mqtt://<Gateway-IP>:1884
Benutzer:   TESVOLT-Zugang
Passwort:   TESVOLT-Zugang
```

Eine spätere TLS-/MQTTS-Konfiguration kann über eine `mqtts://`-URL erfolgen,
sobald TESVOLT Port, Zertifikatskette und Freigabeverfahren bestätigt hat. Die
erste Version verwendet keine kundenspezifischen Zertifikatsdateien.

## Eingelesene Topics

Das Template verarbeitet mehrere JSON-Felder je Topic atomar. Unterstützt sind:

```text
EMS/APIVersion
EMS/V2/Parameters
EMS/V2/TesvoltIoTGateway
EMS/V2/Inverter/Parameters
EMS/V2/Inverter/Limits
EMS/V2/Inverter/Measurements
EMS/V2/Inverter/Energy
EMS/V2/Inverter/State
EMS/V2/Inverter/Errors
EMS/V2/Battery/Parameters
EMS/V2/Battery/Energy
EMS/V2/Battery/Electrical
EMS/V2/Battery/SystemState
EMS/V2/Battery/Errors
```

Damit stehen unter anderem bereit:

- API-, EMS-, Gateway-, Wechselrichter- und Batterieseriennummern
- unterstützte Messwerte, Zustände und Steuergrößen
- nominale und dynamische Lade-/Entladegrenzen
- AC-Wirkleistung und Blindleistung
- AC- und DC-Spannungen
- SOC, Energieinhalt und verfügbare Kapazität
- AC-Lade-/Entladeenergie
- Wechselrichter- und Batteriesystemzustand
- Fehlerlisten zur Anzeige sowie ein konservativ abgeleiteter Fehlerstatus

Fehlerlisten werden nur zur Anzeige ausgewertet. Für Regelentscheidungen nutzt
der Treiber die Zustände `Inverter/State` und `Battery/SystemState`.

## Vorzeichenkonvention

TESVOLT verwendet:

```text
Power > 0  = laden
Power < 0  = entladen
```

NexoWatt EOS verwendet im standardisierten Speicherpfad:

```text
Leistung > 0  = entladen
Leistung < 0  = laden
```

Der Treiber invertiert deshalb Mess- und Sollwerte automatisch.

Beispiele:

| NexoWatt-Sollwert | Bedeutung | TESVOLT `Power` |
|---:|---|---:|
| `+5000 W` | 5 kW entladen | `-5000` |
| `-5000 W` | 5 kW laden | `+5000` |
| `0 W` | Neutral-/Stoppsollwert | `0` |

## Steuerung

Primärer standardisierter Sollwert:

```text
aliases.v1.ctrl.powerSetpointW
```

Rückwärtskompatibler Alias:

```text
aliases.ctrl.powerSetpointW
```

Zusätzlich stehen die getrennten positiven Vorgaben bereit:

```text
aliases.v1.ctrl.chargePowerW
aliases.v1.ctrl.dischargePowerW
```

Der Treiber publiziert auf:

```text
EMS/V2/Inverter/Control
```

Der erste Payload folgt der dokumentierten Struktur:

```json
{
  "Power": 20000,
  "Reactive_Power": 0,
  "State": "grid_connected"
}
```

`Reactive_Power` und `State` werden nur mitgesendet, wenn das Gateway sie in
`supported_control` aufführt. Solange diese Capability-Liste noch nicht bekannt
ist, wird die vollständige dokumentierte Struktur verwendet.

## Sicherheitslogik der Erstimplementierung

Ein Sollwert wird nur gesendet, wenn:

- MQTT verbunden ist,
- `EMS/APIVersion` den Wert `V2` meldet,
- bei einem Wert ungleich 0 `supported_control` die Größe `Power` enthält,
- `Battery/SystemState` frisch ist und `normal` meldet,
- `Inverter/State` frisch ist und nicht `fault`, `off` oder `shutting_down` meldet,
- die passende AC-Grenze aus `Inverter/Limits` frisch und gültig ist.

Der Sollwert wird automatisch auf `P_Max_Charge` beziehungsweise
`P_Max_Discharge` begrenzt. Der tatsächlich gesendete Wert wird anschließend
auch im schreibbaren Datenpunkt und im Alias bestätigt.

Die vorläufigen Fristen bis zur TESVOLT-Rückmeldung sind:

```text
Battery/SystemState:       5 s
AC-Leistungsgrenzen:      60 s
AC-/DC-Leistungsmessung:   5 s
```

Werden AC- oder DC-Leistungswerte zu alt oder fällt MQTT/Heartbeat aus, setzt
der Adapter die operativen Leistungswerte aktiv auf `0 W`, damit im EOS kein
alter Speicherfluss stehen bleibt.

## Bewusst noch nicht aktiviert

Folgende Punkte bleiben bis zur schriftlichen TESVOLT-Antwort deaktiviert oder
vorläufig:

- `EMS/V2/Battery/Control` und `DC_Connection_Request`
- retained Schützbefehle
- automatische Wiederholung eines Wirkleistungssollwerts
- automatische Sollwert-Wiederherstellung nach Neustart
- kundenspezifische TLS-Zertifikate
- Annahmebestätigung beziehungsweise Befehls-ID
- Prioritätslogik gegenüber Modbus, Vermarkter oder anderen EMS-Clients

Damit kann der Feldtest mit Lesen und kontrollierter Wirkleistungsvorgabe
beginnen, ohne die noch ungeklärte DC-Schützfunktion zu verwenden.

## Empfohlener Feldtest

1. Verbindung herstellen und auf frische Daten warten.
2. Prüfen:

```text
aliases.v1.r.online = true
API-Version = V2
Battery System State = normal
allowedChargePower > 0
allowedDischargePower > 0
```

3. Zuerst `0 W` senden.
4. Kleine Entladevorgabe, zum Beispiel `+2000 W`, senden.
5. Kleine Ladevorgabe, zum Beispiel `-2000 W`, senden.
6. Sollwert, `aliases.v1.r.power`, Wechselrichterzustand und dynamische Grenzen
   parallel beobachten.
7. Danach Kommunikationsunterbrechung und Wiederverbindung kontrolliert testen.

Bei einer Ablehnung steht die konkrete Ursache unter:

```text
devices.<id>.info.lastError
```
