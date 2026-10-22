@echo off
REM Registered as the "Open with" app for .kestrel.json (see README.md,
REM "Open workspace files by double-clicking (Windows)"). Windows passes the
REM double-clicked file's path as %1; this hands it to the Node launcher,
REM which serves it (and any data files found next to it) to a browser tab
REM the way a drag-and-drop would.
REM
REM The console window is only a host for the launcher: it re-runs itself
REM minimized, and closes on its own as soon as the browser has the files.
REM Nothing waits for a key press; a problem is reported in a message box.
setlocal
if not "%KESTREL_LAUNCHED%"=="1" (
  set "KESTREL_LAUNCHED=1"
  start "Kestrel" /min "%ComSpec%" /c ""%~f0" "%~1""
  exit /b
)
node "%~dp0open-workspace.mjs" "%~1"
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('Kestrel could not open the workspace file. Check that Node.js is installed (nodejs.org) and that the file still exists, then try again.', 'Kestrel')"
)
endlocal
exit
