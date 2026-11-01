@echo off
setlocal EnableExtensions DisableDelayedExpansion
title OralExam AI Developer Startup
echo OralExam AI - Developer Startup
echo Checking the local environment. Please wait...
echo.
pushd "%~dp0.."
if errorlevel 1 (
    echo Could not open the project folder. Run this file from Windows File Explorer.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Missing repository .venv. Complete docs\developer-startup.md first.
    popd
    pause
    exit /b 1
)

".venv\Scripts\python.exe" -B "scripts\developer_start.py" %*
set "launcherExit=%errorlevel%"
if not "%launcherExit%"=="0" echo Developer startup exited with code %launcherExit%.
popd
pause
exit /b %launcherExit%
