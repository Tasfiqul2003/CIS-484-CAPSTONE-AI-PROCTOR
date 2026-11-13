@echo off
setlocal EnableExtensions DisableDelayedExpansion
title CYBROS Developer Tools
echo CYBROS - Developer Tools
echo Opening tool controls. Please wait...
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

".venv\Scripts\python.exe" -B "scripts\developer_tools.py" %*
set "launcherExit=%errorlevel%"
if not "%launcherExit%"=="0" echo Developer tools exited with code %launcherExit%.
popd
pause
exit /b %launcherExit%
