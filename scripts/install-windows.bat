@echo off
REM Double-click to give .kestrel workspace files Kestrel's icon and make them
REM open in Kestrel. Add -Uninstall to undo. See install-windows.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
