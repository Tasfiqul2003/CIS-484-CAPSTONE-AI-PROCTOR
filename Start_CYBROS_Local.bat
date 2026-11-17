@echo off
setlocal
cd /d "%~dp0"
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"
"%~dp0.venv\Scripts\python.exe" "%~dp0scripts\cybros_local.py" %ACTION%
if errorlevel 1 pause
endlocal
