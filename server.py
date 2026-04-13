"""
SAMSEL Web — static server + health + AutoMix API.
Run:  py -3.10 -m uvicorn server:app --host 0.0.0.0 --port 8765
       Or set SAMSEL_PORT (e.g. 8766) and use --port %SAMSEL_PORT%; /api/health reports the port.

Home Wi‑Fi phones: http://<PC-LAN-IP>:<port> and SAMSEL_AUTOMIX_LAN=1 (firewall: open_samsel_port.bat).

Cloudflare / internet:
  • AutoMix needs Python on your machine — Cloudflare Pages (static-only) cannot run it. Use
    Cloudflare Tunnel (cloudflared) to your PC: http://127.0.0.1:<same port as uvicorn>
  • Set SAMSEL_AUTOMIX_ALLOW_REMOTE=1 and SAMSEL_AUTOMIX_TOKEN=<strong-secret>, restart uvicorn.
    Enter the token in the AutoMix tab (Save on device).
    Optional insecure shortcut: SAMSEL_AUTOMIX_NO_TOKEN=1 skips the token (anyone with the URL can use AutoMix).
  • Split domains (UI on Pages, API on Tunnel): set SAMSEL_CORS_ORIGINS to the Pages origin,
    and on the static page set data-samsel-api-base="https://your-tunnel-host" on <html> (no trailing slash).
"""
import os
import socket
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

from automix_routes import router as automix_router

_BASE = Path(__file__).resolve().parent
STATIC = _BASE / "static"
LOGO_PNG = _BASE / "logo.png"

# ── Jingle control ──────────────────────────────────────────────────
# SAMSEL_JINGLE_UPLOADS=0  → disable user jingle uploads (lock to default)
# SAMSEL_JINGLE_UPLOADS=1  → allow user jingle uploads  (default)
# SAMSEL_JINGLE_PATH       → absolute path to the default jingle MP3
_JINGLE_UPLOADS_ENABLED = os.environ.get("SAMSEL_JINGLE_UPLOADS", "1").strip() != "0"
_JINGLE_PATH_RAW = os.environ.get("SAMSEL_JINGLE_PATH", "").strip()
_JINGLE_PATH = Path(_JINGLE_PATH_RAW) if _JINGLE_PATH_RAW else None

# Bump with static HTML: <meta name="samsel-web-build"> and all asset ?v= query params.
_WEB_BUILD = (os.environ.get("SAMSEL_WEB_BUILD") or "4").strip() or "4"

# So static UI on another host (e.g. Cloudflare Pages) can call health / jingle without SAMSEL_CORS_ORIGINS.
_CORS_PUBLIC = {"Access-Control-Allow-Origin": "*"}

app = FastAPI(title="SAMSEL Web", version="1.0.0")

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


@app.options("/{path:path}")
async def global_options_preflight(path: str):
    """Catch-all OPTIONS so CORS preflights succeed even without SAMSEL_CORS_ORIGINS."""
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Samsel-Automix-Token, X-Samsel-Session, Authorization",
            "Access-Control-Max-Age": "86400",
        },
    )


def _server_port() -> str:
    return (os.environ.get("SAMSEL_PORT") or os.environ.get("PORT") or "8765").strip() or "8765"


def _primary_lan_ipv4() -> str | None:
    """Best-effort LAN address for 'open on phone' hints (may be wrong with VPNs / multiple NICs)."""
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


@app.get("/api/health")
def health():
    port = _server_port()
    lan = _primary_lan_ipv4()
    phone_url = f"http://{lan}:{port}/" if lan else None
    return JSONResponse(
        content={
            "ok": True,
            "service": "samsel-web",
            "version": "1.0.0",
            "web_build": _WEB_BUILD,
            "port": port,
            "lan_ip": lan,
            "phone_url": phone_url,
        },
        headers=_CORS_PUBLIC,
    )


@app.get("/logo.png")
def logo_png():
    """Serve samsel_web/logo.png (same folder as server.py) for the spinning header logo."""
    if LOGO_PNG.is_file():
        return FileResponse(
            LOGO_PNG,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=3600, must-revalidate"},
        )
    return Response(status_code=404)


# ── Jingle API ──────────────────────────────────────────────────────
@app.get("/api/jingle/config")
def jingle_config():
    """Tell the frontend whether user uploads are allowed and if a default jingle exists."""
    has_default = bool(_JINGLE_PATH and _JINGLE_PATH.is_file())
    return JSONResponse(
        content={
            "uploads_enabled": _JINGLE_UPLOADS_ENABLED,
            "has_default_jingle": has_default,
            "default_jingle_name": _JINGLE_PATH.name if has_default else None,
        },
        headers=_CORS_PUBLIC,
    )


@app.get("/api/jingle/default")
def jingle_default():
    """Stream the server-configured default jingle file."""
    if not _JINGLE_PATH or not _JINGLE_PATH.is_file():
        return Response(status_code=404)
    return FileResponse(
        _JINGLE_PATH,
        media_type="audio/mpeg",
        filename=_JINGLE_PATH.name,
        headers={"Cache-Control": "public, max-age=86400", **_CORS_PUBLIC},
    )


_MANIFEST = STATIC / "manifest.webmanifest"
# Optional assets for camo-themed UI; also mirrored at static/img/camo-tile.svg for CSS.
_CAMO = _BASE / "Camouflage_png"


@app.get("/manifest.webmanifest")
def web_manifest():
    """PWA manifest with correct MIME (iOS/Android Add to Home Screen)."""
    if _MANIFEST.is_file():
        return FileResponse(_MANIFEST, media_type="application/manifest+json")
    return Response(status_code=404)


if _CAMO.is_dir():
    app.mount("/camo", StaticFiles(directory=str(_CAMO)), name="camouflage")

app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
