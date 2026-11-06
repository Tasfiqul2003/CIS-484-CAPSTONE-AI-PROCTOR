@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0Developer Mode\Start_Developer.bat" %*
exit /b %errorlevel%
