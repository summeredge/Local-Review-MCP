@echo off
if "%~1"=="--version" goto version
if "%~1"=="run" goto run
if "%~1"=="start" goto start
exit /b 0
:version
echo 10.0.0
exit /b 0
:run
echo run build>>"%~dp0npm-log.txt"
if "%NPM_SHIM_BUILD_EXIT%"=="1" exit /b 1
exit /b 0
:start
echo start>>"%~dp0npm-log.txt"
exit /b 0
