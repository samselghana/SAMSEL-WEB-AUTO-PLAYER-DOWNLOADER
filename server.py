"""
SAMSEL Web — static server + health + AutoMix API.
Run:  py -3.10 -m uvicorn server:app --host 0.0.0.0 --port 8765
       Or set SAMSEL_PORT (e.g. 8766) and use --port %SAMSEL_PORT%; /api/health reports the port.

Railway: use GET /health for deploy healthcheck (plain ok). Heavy deps load lazily so startup stays fast.

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
import re
import socket
import sys
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
# SAMSEL_JINGLE_PATH       → one or more paths separated by ;  (first existing file wins)
# SAMSEL_WEB_ENGINE        → one or more folders; each checked for SAMSEL_AutoMix_Jingle_3.mp3
# Auto-probes: samsel_web sibling folders, then %USERPROFILE%\base\SAMSEL_WEB\SAMSEL-WEB-ENGINE\...
# Last resort: assets/SAMSEL_AutoMix_Jingle_3.mp3, then assets/default-jingle.mp3
_JINGLE_UPLOADS_ENABLED = os.environ.get("SAMSEL_JINGLE_UPLOADS", "1").strip() != "0"
_JINGLE_NAME = "SAMSEL_AutoMix_Jingle_3.mp3"
# Optional: override default_jingle_name in /api/jingle/config (and download filename) only.
_JINGLE_DISPLAY_NAME = (os.environ.get("SAMSEL_JINGLE_DISPLAY_NAME") or "").strip()


def _resolve_one_path(raw: str) -> Path | None:
    raw = raw.strip()
    if not raw:
        return None
    p = Path(raw).expanduser()
    p = p.resolve() if p.is_absolute() else (_BASE / p).resolve()
    return p if p.is_file() else None


def _is_bundled_placeholder_jingle(p: Path) -> bool:
    return p.name.lower() == "default-jingle.mp3"


def _resolve_jingle_path() -> tuple[Path | None, str]:
    # 1) SAMSEL_JINGLE_PATH (;-separated) — ignore segments that resolve to the tiny placeholder only
    raw_paths = os.environ.get("SAMSEL_JINGLE_PATH", "").strip()
    if raw_paths:
        for segment in re.split(r"[;|]", raw_paths):
            hit = _resolve_one_path(segment)
            if hit is not None and not _is_bundled_placeholder_jingle(hit):
                return hit, "env_path"

    # 2) Next to server.py
    sidecar = (_BASE / _JINGLE_NAME).resolve()
    if sidecar.is_file():
        return sidecar, "samsel_web"

    # 2b) Shipped with samsel_web (works on tunnel PCs with no engine clone / no env)
    _pack = (_BASE / "assets" / _JINGLE_NAME).resolve()
    if _pack.is_file():
        return _pack, "assets_automix"

    # 3) SAMSEL_WEB_ENGINE (;-separated), each root / SAMSEL_AutoMix_Jingle_3.mp3
    eng_raw = os.environ.get("SAMSEL_WEB_ENGINE", "").strip()
    if eng_raw:
        for segment in re.split(r"[;|]", eng_raw):
            seg = segment.strip()
            if not seg:
                continue
            root = Path(seg).expanduser().resolve()
            hit = (root / _JINGLE_NAME).resolve()
            if hit.is_file():
                return hit, "engine_env"

    # 4) Common folder layouts (no env required)
    for rel in (
        _BASE.parent / "SAMSEL-WEB-ENGINE",
        _BASE.parent / "SAMSEL_WEB" / "SAMSEL-WEB-ENGINE",
        _BASE.parent.parent / "SAMSEL-WEB-ENGINE",
        _BASE.parent.parent / "SAMSEL_WEB" / "SAMSEL-WEB-ENGINE",
    ):
        hit = (rel / _JINGLE_NAME).resolve()
        if hit.is_file():
            return hit, "engine_sibling"

    # 4b) Walk up from samsel_web (e.g. …\Downloads\PACK\samsel_web → user home) for base\SAMSEL_WEB\SAMSEL-WEB-ENGINE\
    try:
        cursor = _BASE.resolve()
        for _ in range(6):
            hit = (cursor / "base" / "SAMSEL_WEB" / "SAMSEL-WEB-ENGINE" / _JINGLE_NAME).resolve()
            if hit.is_file():
                return hit, "engine_walk"
            if cursor.parent == cursor:
                break
            cursor = cursor.parent
    except (OSError, ValueError):
        pass

    # 5) Typical clone under %USERPROFILE%\base\SAMSEL_WEB\SAMSEL-WEB-ENGINE\
    if sys.platform == "win32":
        prof = (os.environ.get("USERPROFILE") or "").strip()
        if prof:
            hit = (Path(prof) / "base" / "SAMSEL_WEB" / "SAMSEL-WEB-ENGINE" / _JINGLE_NAME).resolve()
            if hit.is_file():
                return hit, "engine_userprofile"

    # 6) Bundled placeholder
    bundled = (_BASE / "assets" / "default-jingle.mp3").resolve()
    if bundled.is_file():
        return bundled, "bundled"

    return None, "none"


_JINGLE_PATH, _JINGLE_SOURCE = _resolve_jingle_path()
_JINGLE_MTIME: float = 0.0
if _JINGLE_PATH and _JINGLE_PATH.is_file():
    try:
        _JINGLE_MTIME = _JINGLE_PATH.stat().st_mtime
    except OSError:
        pass
if os.environ.get("SAMSEL_JINGLE_LOG", "").strip() == "1":
    print(
        f"samsel-web jingle: source={_JINGLE_SOURCE} path={_JINGLE_PATH!s}",
        file=sys.stderr,
    )


def _refresh_jingle() -> None:
    """Re-resolve jingle path so file changes take effect without restart."""
    global _JINGLE_PATH, _JINGLE_SOURCE, _JINGLE_MTIME
    _JINGLE_PATH, _JINGLE_SOURCE = _resolve_jingle_path()
    _JINGLE_MTIME = 0.0
    if _JINGLE_PATH and _JINGLE_PATH.is_file():
        try:
            _JINGLE_MTIME = _JINGLE_PATH.stat().st_mtime
        except OSError:
            pass
    if os.environ.get("SAMSEL_JINGLE_LOG", "").strip() == "1":
        print(
            f"samsel-web jingle (refreshed): source={_JINGLE_SOURCE} path={_JINGLE_PATH!s}",
            file=sys.stderr,
        )


def _jingle_file_changed() -> bool:
    """Check if the resolved jingle file has been modified since last resolve."""
    if not _JINGLE_PATH:
        return False
    try:
        if not _JINGLE_PATH.is_file():
            return True
        return _JINGLE_PATH.stat().st_mtime != _JINGLE_MTIME
    except OSError:
        return True

# Bump with static HTML: <meta name="samsel-web-build"> and all asset ?v= query params.
_WEB_BUILD = (os.environ.get("SAMSEL_WEB_BUILD") or "5").strip() or "5"

# So static UI on another host (e.g. Cloudflare Pages) can call health / jingle without SAMSEL_CORS_ORIGINS.
_CORS_PUBLIC = {"Access-Control-Allow-Origin": "*"}
# Stops Cloudflare / browsers caching API JSON as if it were static (fixes stale jingle on custom domain).
_NO_STORE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
}


def _jingle_name_for_api() -> str | None:
    if not _JINGLE_PATH or not _JINGLE_PATH.is_file():
        return None
    if _JINGLE_DISPLAY_NAME:
        return _JINGLE_DISPLAY_NAME
    return _JINGLE_PATH.name


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


@app.get("/health")
def health_railway():
    """Minimal probe for Railway / load balancers (no imports, no socket work)."""
    return Response(content="ok", media_type="text/plain", headers=_CORS_PUBLIC)


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
    if os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("RAILWAY_PROJECT_ID"):
        return None
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
    if _jingle_file_changed():
        _refresh_jingle()
    port = _server_port()
    lan = _primary_lan_ipv4()
    phone_url = f"http://{lan}:{port}/" if lan else None
    has_j = bool(_JINGLE_PATH and _JINGLE_PATH.is_file())
    return JSONResponse(
        content={
            "ok": True,
            "service": "samsel-web",
            "version": "1.0.0",
            "web_build": _WEB_BUILD,
            "port": port,
            "lan_ip": lan,
            "phone_url": phone_url,
            "jingle_source": _JINGLE_SOURCE if has_j else "none",
            "default_jingle_name": _jingle_name_for_api() if has_j else None,
        },
        headers={**_CORS_PUBLIC, **_NO_STORE},
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
    if _jingle_file_changed():
        _refresh_jingle()
    has_default = bool(_JINGLE_PATH and _JINGLE_PATH.is_file())
    src = _JINGLE_SOURCE if has_default else "none"
    etag_val = f'"{src}-{_JINGLE_MTIME:.0f}-{int(has_default)}"'
    return JSONResponse(
        content={
            "uploads_enabled": _JINGLE_UPLOADS_ENABLED,
            "has_default_jingle": has_default,
            "default_jingle_name": _jingle_name_for_api(),
            "jingle_source": src,
        },
        headers={
            **_CORS_PUBLIC,
            **_NO_STORE,
            "X-Samsel-Jingle-Source": src,
            "ETag": etag_val,
        },
    )


@app.get("/api/jingle/default")
def jingle_default():
    """Stream the server-configured default jingle file."""
    if _jingle_file_changed():
        _refresh_jingle()
    if not _JINGLE_PATH or not _JINGLE_PATH.is_file():
        return Response(status_code=404)
    _fname = _JINGLE_DISPLAY_NAME or _JINGLE_PATH.name
    etag_val = f'"{_JINGLE_SOURCE}-{_JINGLE_MTIME:.0f}"'
    return FileResponse(
        _JINGLE_PATH,
        media_type="audio/mpeg",
        filename=_fname,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "ETag": etag_val,
            **_CORS_PUBLIC,
        },
    )


@app.post("/api/jingle/reload")
def jingle_reload():
    """Force re-resolve the jingle file without restarting the server."""
    _refresh_jingle()
    has_default = bool(_JINGLE_PATH and _JINGLE_PATH.is_file())
    return JSONResponse(
        content={
            "reloaded": True,
            "has_default_jingle": has_default,
            "default_jingle_name": _jingle_name_for_api(),
            "jingle_source": _JINGLE_SOURCE if has_default else "none",
        },
        headers={**_CORS_PUBLIC, **_NO_STORE},
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


if __name__ == "__main__":
    import uvicorn

    # Railway sets PORT; local dev often uses SAMSEL_PORT or 8765.
    _port = int(
        (os.environ.get("PORT") or os.environ.get("SAMSEL_PORT") or "8765").strip() or "8765"
    )
    uvicorn.run("server:app", host="0.0.0.0", port=_port)
