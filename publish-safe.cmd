@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo NexoWatt sichere Veroeffentlichung
echo ============================================================

echo [1/3] Unabhaengige Release-Pruefung...
node scripts\release-guard.cjs
if errorlevel 1 goto :failed

echo [2/3] Automatische Tests...
call npm test
if errorlevel 1 goto :failed

echo [3/3] NPM-Paketvorschau...
call npm pack --dry-run
if errorlevel 1 goto :failed

if /I "%~1"=="--publish" (
  echo.
  echo Alle Pruefungen bestanden. NPM-Veroeffentlichung startet...
  call npm publish
  if errorlevel 1 goto :failed
  echo.
  echo Veroeffentlichung erfolgreich abgeschlossen.
  exit /b 0
)

echo.
echo Alle Pruefungen bestanden. Es wurde NICHT veroeffentlicht.
echo Zum Veroeffentlichen ausfuehren: publish-safe.cmd --publish
exit /b 0

:failed
echo.
echo ABBRUCH: Es wurde nichts veroeffentlicht.
exit /b 1
