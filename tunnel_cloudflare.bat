@echo off
cd /d "%~dp0"
if "%SAMSEL_PORT%"=="" set SAMSEL_PORT=8765
echo.
echo  THIS FILE = QUICK tunnel only (random *.trycloudflare.com URL each run).
echo  For your own domain (e.g. samsel-automix.com), use Option A instead:
echo    - Read OPTION_A_TUNNEL_CHECKLIST.txt
echo    - Run tunnel_option_a_run.bat  (after Zero Trust tunnel + Public Hostname)
echo.
echo  Quick tunnel -^> http://127.0.0.1:%SAMSEL_PORT%
echo  Start SAMSEL Web first: run_web.bat  (or uvicorn) in another window.
echo  Use the same SAMSEL_PORT as run_web.bat if not 8765.
echo.
where cloudflared >nul 2>&1
if errorlevel 1 (
  echo [ERROR] cloudflared not in PATH.
  echo   winget install Cloudflare.cloudflared
  echo   https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
  pause
  exit /b 1
)
cloudflared tunnel --url http://127.0.0.1:%SAMSEL_PORT%
pause
