@echo off
REM Registered as the "Open with" app for .kestrel.json (see README.md,
REM "Open workspace files by double-clicking (Windows)"). Windows passes the
REM double-clicked file's path as %1; this hands it to the Node launcher,
REM which serves it to a browser tab the way a drag-and-drop would.
setlocal
node "%~dp0open-workspace.mjs" "%~1"
if errorlevel 1 (
  echo.
  echo Kestrel couldn't open "%~1". Press any key to close this window.
  pause >nul
)
endlocal
