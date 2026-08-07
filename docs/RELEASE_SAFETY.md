# NexoWatt Devices – sichere Release-Prüfung

Die erste Freigabeprüfung wird direkt mit Node.js gestartet. Dadurch erkennt sie auch einen beschädigten Projektstand, bevor ein Paket veröffentlicht wird. Das frühere Windows-Skript `publish-safe.cmd` ist ab Version 0.5.148 nicht mehr Bestandteil der ZIP oder des npm-Pakets.

## Prüfung ohne Veröffentlichung

Im Projektordner:

```powershell
node .\scripts\release-guard.cjs
npm test
npm pack --dry-run
```

Unter Linux sind dieselben Befehle mit `/` statt `\\` verwendbar:

```bash
node ./scripts/release-guard.cjs
npm test
npm pack --dry-run
```

## Geprüft veröffentlichen

Erst nachdem alle drei Prüfungen erfolgreich waren:

```powershell
npm publish
```

Der Ablauf muss vor der Veröffentlichung abgebrochen werden, wenn mindestens einer dieser Punkte fehlschlägt:

- ungelöste Git-Merge-Konflikte
- ungültige JSON-Dateien
- unterschiedliche Versionen in `package.json` und `io-package.json`
- unterschiedliche `admin/templates.json` und `lib/templates.json`
- JavaScript-Syntaxfehler
- automatisierte Adaptertests
- `npm pack --dry-run`

## Schutz vor vermischten Versionen

`npm test` verwendet ab Version 0.5.146 das feste Manifest
`test/test-manifest.json`. Der Release-Guard vergleicht das Manifest mit den
vorhandenen `test/*.test.js`-Dateien.

Eine alte zusätzliche Testdatei führt dadurch nicht mehr erst zu einem
unverständlichen `ERR_ASSERTION`, sondern zu dieser eindeutigen Freigabesperre:

```text
alte oder fremde Testdateien gefunden
Der Projektordner wurde wahrscheinlich über eine ältere Version kopiert.
Ordner löschen und die ZIP sauber neu entpacken.
```

## Schutz bestehender Anlagen

Vor jeder Freigabe wird zusätzlich die Kompatibilitätsbaseline 0.5.143 geprüft.
Dabei müssen alle 181 Roh-Templates sowie sämtliche bisherigen
`devices.<id>.aliases.*`-Definitionen unverändert bleiben. Alias Contract v1 darf
nur neue Objekte unter `aliases.v1.*` und `aliases.meta.*` hinzufügen.
