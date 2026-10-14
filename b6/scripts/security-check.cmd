@echo off
rem Dark Questate security check: installs Slither if needed, then runs Slither, the builds, every
rem test suite, the integrity gate and a dependency audit. Reports go to reports\.
rem Double-click it, or run:  scripts\security-check.cmd [-SlitherOnly] [-SkipInstall]
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0security-check.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
echo Finished with exit code %RC%. Reports: "%~dp0..\reports"
if "%~1"=="" pause
exit /b %RC%
