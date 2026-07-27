# NexoWatt Devices – sichere Release-Prüfung

Die Freigabeprüfung ist absichtlich unabhängig von `npm`. Dadurch erkennt sie auch ein beschädigtes `package.json`, bevor `npm publish` gestartet wird.

## Prüfung ohne Veröffentlichung

Unter Windows im Projektordner:

```powershell
.\publish-safe.cmd
```

## Geprüft veröffentlichen

```powershell
.\publish-safe.cmd --publish
```

Der Ablauf bricht vor der Veröffentlichung ab, wenn mindestens einer dieser Punkte fehlschlägt:

- ungelöste Git-Merge-Konflikte
- ungültige JSON-Dateien
- unterschiedliche Versionen in `package.json` und `io-package.json`
- unterschiedliche `admin/templates.json` und `lib/templates.json`
- JavaScript-Syntaxfehler
- automatisierte Adaptertests
- `npm pack --dry-run`

Direkter Einzelaufruf der unabhängigen Prüfung:

```powershell
node .\scripts\release-guard.cjs
```
