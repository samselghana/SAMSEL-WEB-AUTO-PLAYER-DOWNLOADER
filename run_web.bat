@echo off
cd /d "%~dp0"

REM HTTP port for uvicorn. Override: set SAMSEL_PORT=8766 in this file (before the next line) or in the environment.
if "%SAMSEL_PORT%"=="" set SAMSEL_PORT=8765

REM Phones on home Wi-Fi (private LAN). Remove to lock AutoMix to this PC only.
set SAMSEL_AUTOMIX_LAN=1
REM Cloudflare / internet phones: also set before py -m uvicorn:
set SAMSEL_AUTOMIX_ALLOW_REMOTE=1
set SAMSEL_AUTOMIX_NO_TOKEN=1
REM To require a token instead (recommended): comment the NO_TOKEN line above, uncomment below, and set a strong secret:
REM   set SAMSEL_AUTOMIX_TOKEN=your-long-random-secret
REM Split UI/API domains: set SAMSEL_CORS_ORIGINS=https://your.pages.dev

py -3.10 -m pip install -r requirements.txt -q

echo.
echo ========== SAMSEL Web ==========
echo This PC browser:  http://127.0.0.1:%SAMSEL_PORT%/
py -3.10 phone_url_print.py
echo.
echo If the phone shows "cannot connect" or times out:
echo   1) Same Wi-Fi as this PC   2) Use http:// not https://
echo   3) Run open_samsel_port.bat as Administrator (Windows Firewall — use the same SAMSEL_PORT)
echo.

start "" "http://127.0.0.1:%SAMSEL_PORT%/"
py -3.10 -m uvicorn server:app --host 0.0.0.0 --port %SAMSEL_PORT%
pause
