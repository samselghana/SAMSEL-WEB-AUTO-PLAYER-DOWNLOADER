@echo off
cd /d "%~dp0"
if "%SAMSEL_PORT%"=="" set SAMSEL_PORT=8765

REM =============================================================================
REM Option A — One hostname (e.g. samsel-automix.com) -> this PC only (uvicorn)
REM =============================================================================
REM Before first run (Cloudflare dashboard — do once):
REM   1) Workers & Pages: remove custom domain from samsel-automix.com if you see
REM      "DNS managed by Workers" (apex must be free for the tunnel CNAME).
REM   2) Zero Trust -> Networks -> Tunnels -> Create tunnel (or open existing).
REM   3) Public hostname:
REM        Subdomain: @     Domain: samsel-automix.com
REM        Type: HTTP      URL: http://127.0.0.1:%SAMSEL_PORT%
REM      (Optional) Repeat for www -> same URL, or add redirect in Cloudflare.
REM   4) Note the tunnel NAME you chose (below).
REM Every session (this PC):
REM   Window 1: run_web.bat
REM   Window 2: this file (tunnel_option_a_run.bat)
REM =============================================================================

REM Set this to the exact tunnel name from: cloudflared tunnel list
if "%SAMSEL_CF_TUNNEL_NAME%"=="" set SAMSEL_CF_TUNNEL_NAME=samsel-automix

echo.
echo  Option A: cloudflared tunnel run "%SAMSEL_CF_TUNNEL_NAME%"
echo  Service on this PC must be: http://127.0.0.1:%SAMSEL_PORT%  (run_web.bat)
echo.

where cloudflared >nul 2>&1
if errorlevel 1 (
  echo [ERROR] cloudflared not in PATH.
  echo   winget install Cloudflare.cloudflared
  pause
  exit /b 1
)

cloudflared tunnel run "%SAMSEL_CF_TUNNEL_NAME%"
echo.
echo Tunnel exited.
pause
