@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Resolve the repository root from this launcher's location.
cd /d "%~dp0.." || exit /b 1

if not exist ".venv\Scripts\python.exe" (
    echo Missing repository .venv. Complete docs\setup.md first.
    pause
    exit /b 1
)
if not exist "en_US-lessac-medium.onnx" (
    echo Missing Piper model. Download en_US-lessac-medium into the repository root.
    echo See docs\setup.md for the download command.
    pause
    exit /b 1
)
if not exist "en_US-lessac-medium.onnx.json" (
    echo Missing Piper model configuration. Download the voice and configuration together.
    pause
    exit /b 1
)

rem Use the environment interpreter directly; activation and PowerShell policy changes are unnecessary.
".venv\Scripts\python.exe" "backend\ai_oral_examiner_foundation_v1.py"
set "launcherExit=%errorlevel%"
if not "%launcherExit%"=="0" echo Program exited with code %launcherExit%. Review the output above.
pause
exit /b %launcherExit%
