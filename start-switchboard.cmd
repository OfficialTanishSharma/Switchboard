@echo off
setlocal
cd /d "%~dp0"
title Switchboard AI Gateway
node server.js
if errorlevel 1 (
  echo.
  echo Switchboard stopped with an error. Review the message above.
  pause
)
