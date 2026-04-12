"""
AutoMix Downloader v2 — standalone web app only (no SAMSEL player).

Same REST API as the AutoMix tab in server.py: /api/automix/*, shared automix_core engine.

Run:
  py -3.10 -m uvicorn automix_standalone_app:app --host 0.0.0.0 --port 8765
  run_automix_standalone.bat
  py AutoMix_DownLoader_v2.py --web

Env: SAMSEL_PORT, SAMSEL_AUTOMIX_*, SAMSEL_CORS_ORIGINS (same as SAMSEL Web).
"""
from __future__ import annotations

import os
import socket
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

from automix_routes import router as automix_router

_BASE = Path(__file__).resolve().parent
STATIC = _BASE / "static"
_CAMO = _BASE / "Camouflage_png"
LOGO_PNG = _BASE / "logo.png"
LOGO_SVG = STATIC / "logo.svg"
STANDALONE_HTML = STATIC / "automix_standalone.html"
_MANIFEST = STATIC / "manifest.webmanifest"

app = FastAPI(title="AutoMix Downloader v2 (Web)", version="2.0.0")

_cors_raw = os.environ.get("SAMSEL_CORS_ORIGINS", "").strip()
if _cors_raw:
    _cors_list = [o.strip() for o in _cors_raw.split(",") if o.strip()]
    if _cors_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=_cors_list,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

app.include_router(automix_router)


def _server_port() -> str:
    return (os.environ.get("SAMSEL_PORT") or os.environ.get("PORT") or "8765").strip() or "8765"


def _primary_lan_ipv4() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(0.25)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    return None


@app.get("/")
def standalone_page():
    if not STANDALONE_HTML.is_file():
        return Response("static/automix_standalone.html missing", status_code=500)
    return FileResponse(STANDALONE_HTML, media_type="text/html; charset=utf-8")


@app.get("/api/health")
def health():
    port = _server_port()
    lan = _primary_lan_ipv4()
    return {
        "ok": True,
        "service": "automix-standalone-web",
        "version": "2.0.0",
        "port": port,
        "lan_ip": lan,
        "phone_url": f"http://{lan}:{port}/" if lan else None,
    }


@app.get("/logo.png")
def logo_png():
    if LOGO_PNG.is_file():
        return FileResponse(LOGO_PNG, media_type="image/png")
    return Response(status_code=404)


@app.get("/logo.svg")
def logo_svg():
    if LOGO_SVG.is_file():
        return FileResponse(LOGO_SVG, media_type="image/svg+xml")
    return Response(status_code=404)


@app.get("/manifest.webmanifest")
def web_manifest():
    """PWA manifest for Add to Home Screen (iOS / Android)."""
    if _MANIFEST.is_file():
        return FileResponse(_MANIFEST, media_type="application/manifest+json")
    return Response(status_code=404)


if _CAMO.is_dir():
    app.mount("/camo", StaticFiles(directory=str(_CAMO)), name="camouflage")

app.mount("/css", StaticFiles(directory=str(STATIC / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(STATIC / "js")), name="js")
app.mount("/img", StaticFiles(directory=str(STATIC / "img")), name="img")
