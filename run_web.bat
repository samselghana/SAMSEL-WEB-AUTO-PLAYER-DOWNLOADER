@echo off
cd /d "%~dp0"

REM HTTP port for uvicorn. Override: set SAMSEL_PORT=8766 in this file (before the next line) or in the environment.
if "%SAMSEL_PORT%"=="" set SAMSEL_PORT=8765
set "SAMSEL_PORT=%SAMSEL_PORT:"=%"

REM Phones on home Wi-Fi (private LAN). Remove to lock AutoMix to this PC only.
set SAMSEL_AUTOMIX_LAN=1
REM Cloudflare / internet phones: also set before py -m uvicorn:
set SAMSEL_AUTOMIX_ALLOW_REMOTE=1
set SAMSEL_AUTOMIX_NO_TOKEN=1
REM To require a token instead (recommended): comment the NO_TOKEN line above, uncomment below, and set a strong secret:
REM   set SAMSEL_AUTOMIX_TOKEN=your-long-random-secret
REM Split UI/API domains: set SAMSEL_CORS_ORIGINS=https://your.pages.dev

REM ── Jingle control ──
REM Set to 0 to DISABLE user jingle uploads (lock to the default jingle below).
REM Set to 1 (or leave unset) to ALLOW users to pick their own jingle file.
set SAMSEL_JINGLE_UPLOADS=0
REM server.py tries each path in order (;). First hit wins. Put the file next to server.py for portable packs.
if not defined SAMSEL_BASE set "SAMSEL_BASE=%USERPROFILE%\base"
set "SAMSEL_JINGLE_PATH=%~dp0SAMSEL_AutoMix_Jingle_3.mp3;%SAMSEL_BASE%\SAMSEL_WEB\SAMSEL-WEB-ENGINE\SAMSEL_AutoMix_Jingle_3.mp3"
REM Extra engine roots (;) — used if SAMSEL_JINGLE_PATH segments all miss (optional).
if not defined SAMSEL_WEB_ENGINE set "SAMSEL_WEB_ENGINE=%SAMSEL_BASE%\SAMSEL_WEB\SAMSEL-WEB-ENGINE"
REM Log which jingle file loaded: set SAMSEL_JINGLE_LOG=1

REM After a deploy, verify: open https://your-domain/api/health — "web_build" must match
REM static/index.html <meta name="samsel-web-build"> and ?v= on CSS/JS. Bump all three next release.

py -3.10 -m pip install -r requirements.txt -q

echo.
echo ========== SAMSEL Web ==========
echo Stable Cloudflare: SAMSEL Web -^> tunnel_option_a_run.bat  ^|  DJ -^> run_dj_named_tunnel.bat ^(SAMSEL_DJ_ENGINE_CLOUDFLARE.txt^)
echo Tunnel URL in Zero Trust must be 127.0.0.1:%SAMSEL_PORT% ^(same as this window^). Mismatch: CLOUDFLARE_FIX_SAMSEL_AUTOMIX_PORT.txt  ^|  open_zero_trust_tunnels.bat
echo This PC browser:  http://127.0.0.1:%SAMSEL_PORT%/
py -3.10 phone_url_print.py
echo.
echo If the phone shows "cannot connect" or times out:
echo   1) Same Wi-Fi as this PC   2) Use http:// not https://
echo   3) Run open_samsel_port.bat as Administrator (Windows Firewall - use the same SAMSEL_PORT)
echo.

set "SAMSEL_LOCAL_URL=http://127.0.0.1:%SAMSEL_PORT%/"
REM Browser auto-open is opt-in to avoid Windows "cannot find URL" popups in some shell contexts.
REM Enable only if you want it:
REM   set SAMSEL_AUTO_OPEN_BROWSER=1
if /i "%SAMSEL_AUTO_OPEN_BROWSER%"=="1" (
  start "" cmd /c start "" "%SAMSEL_LOCAL_URL%"
)
set "SAMSEL_HEALTHCHK=http://127.0.0.1:%SAMSEL_PORT%/health"
if exist "%SystemRoot%\System32\curl.exe" (
  "%SystemRoot%\System32\curl.exe" -fsS --connect-timeout 2 --max-time 2 "%SAMSEL_HEALTHCHK%" >nul 2>&1
) else (
  powershell -NoProfile -Command "$null = Invoke-WebRequest -Uri 'http://127.0.0.1:%SAMSEL_PORT%/health' -UseBasicParsing -TimeoutSec 2" >nul 2>&1
)
if not errorlevel 1 (
  echo [INFO] Server already running on port %SAMSEL_PORT% ^(/health returned 200^). Skipping second uvicorn start.
  pause
  exit /b 0
)
py -3.10 -m uvicorn server:app --host 0.0.0.0 --port %SAMSEL_PORT%
pause

