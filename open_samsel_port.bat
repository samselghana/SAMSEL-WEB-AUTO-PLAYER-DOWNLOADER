@echo off
title SAMSEL Web — firewall rule
if "%SAMSEL_PORT%"=="" set SAMSEL_PORT=8765
echo Adds an inbound Windows Firewall rule for TCP port %SAMSEL_PORT% (SAMSEL Web).
echo Set SAMSEL_PORT before running this file if you use a non-default port (must match run_web.bat).
echo You must right-click this file and choose "Run as administrator" if it fails.
echo.
netsh advfirewall firewall add rule name="SAMSEL Web %SAMSEL_PORT%" dir=in action=allow protocol=TCP localport=%SAMSEL_PORT%
if errorlevel 1 (
  echo.
  echo FAILED. Run this batch file as Administrator.
  pause
  exit /b 1
)
echo.
echo Done. Try your phone again at http://YOUR-PC-IP:%SAMSEL_PORT%/
pause
