@echo off
cd /d "%~dp0"

REM Same AutoMix as SAMSEL Web tab, but only this app (no music player UI).
if "%SAMSEL_PORT%"=="" set SAMSEL_PORT=8765

REM Phones on Wi‑Fi (optional, same as run_web.bat):
set SAMSEL_AUTOMIX_LAN=1
REM REM set SAMSEL_AUTOMIX_ALLOW_REMOTE=1
REM REM set SAMSEL_AUTOMIX_TOKEN=your-secret

py -3.10 -m pip install -r requirements.txt -q

echo.
echo ========== AutoMix Downloader v2 (standalone web) ==========
echo Open:  http://127.0.0.1:%SAMSEL_PORT%/
py -3.10 phone_url_print.py
echo Or run desktop Tk:  py AutoMix_DownLoader_v2.py
echo.

start "" "http://127.0.0.1:%SAMSEL_PORT%/"
py -3.10 -m uvicorn automix_standalone_app:app --host 0.0.0.0 --port %SAMSEL_PORT%
pause
