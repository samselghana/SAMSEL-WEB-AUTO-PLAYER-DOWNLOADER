"""
AutoMix Downloader v2 — HTTP API + SSE (localhost by default; optional LAN for phones).

Environment:
  SAMSEL_AUTOMIX_LAN=1       Allow clients on private LAN (RFC1918: 192.168.x, 10.x, etc.).
  SAMSEL_AUTOMIX_ALLOW_REMOTE=1  Allow internet / Cloudflare Tunnel visitors (non-private IPs).
                             Normally requires SAMSEL_AUTOMIX_TOKEN for non-localhost clients.
  SAMSEL_AUTOMIX_TOKEN=…     Shared secret: header X-Samsel-Automix-Token, Bearer, or ?token= on GET.
                             Localhost (this PC) never needs the token.
  SAMSEL_AUTOMIX_NO_TOKEN=1  Do not require a token (LAN and/or ALLOW_REMOTE still required for
                             non-localhost). Insecure on the public internet — use only if you accept
                             that anyone with the tunnel URL can queue jobs and download outputs.

Runs the same DownloaderEngine as the desktop app (yt-dlp, syncedlyrics, mutagen, librosa on the server).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time as _time
import uuid
import zipfile
from collections import deque
from dataclasses import asdict, fields
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

import mimetypes

import automix_core as _ac

from automix_core import (
    AppConfig,
    DownloaderEngine,
    SUPPORTED_AUDIO_EXTS,
    ensure_dir,
    find_executable,
    resolve_ffmpeg_dir,
    ts,
)

_BASE = Path(__file__).resolve().parent
_UPLOADS = _BASE / ".automix_uploads"

_automix_env = os.environ.get("SAMSEL_AUTOMIX_SCRIPT")
AUTOMIX_SCRIPT = (
    Path(_automix_env).expanduser().resolve()
    if _automix_env
    else (_BASE / "AutoMix_DownLoader_v2.py")
    if (_BASE / "AutoMix_DownLoader_v2.py").is_file()
    else (_BASE / "tools" / "automix" / "AutoMix_DownLoader_v2.py")
)
AUTOMIX_CWD = AUTOMIX_SCRIPT.parent

router = APIRouter(prefix="/api/automix", tags=["automix"])

_lock = threading.RLock()
_log_deque: deque[str] = deque(maxlen=5000)
_live: dict[str, Any] = {
    "progress": 0.0,
    "eta": "",
    "status": "Ready",
    "worker_alive": False,
    "jobs": [],
}

_engine: Optional[DownloaderEngine] = None

# ---------------------------------------------------------------------------
# Per-client session management — remote devices get isolated temp output dirs
# so downloaded files are auto-delivered to the phone and not stored on the host.
# ---------------------------------------------------------------------------
_REMOTE_SESSIONS_DIR = _BASE / ".automix_remote_sessions"
_SESSION_MAX_AGE = 4 * 3600  # 4 hours

_sessions: dict[str, dict[str, Any]] = {}
_session_lock = threading.Lock()
_pending_ack_delete_timers: list[threading.Timer] = []


def _get_session_id(request: Request) -> str:
    sid = (request.headers.get("x-samsel-session") or "").strip()
    if not sid:
        sid = (request.query_params.get("session") or "").strip()
    return sid


def _ensure_session(session_id: str, is_remote: bool) -> dict[str, Any]:
    """Return (or create) session metadata.  Remote sessions get a private temp dir."""
    with _session_lock:
        if session_id in _sessions:
            _sessions[session_id]["touched"] = _time.time()
            return _sessions[session_id]
        info: dict[str, Any] = {
            "created": _time.time(),
            "touched": _time.time(),
            "is_remote": is_remote,
            "dir": None,
        }
        if is_remote:
            sdir = _REMOTE_SESSIONS_DIR / session_id
            sdir.mkdir(parents=True, exist_ok=True)
            info["dir"] = sdir
        _sessions[session_id] = info
        return info


def _output_dir_for_request(request: Request) -> str:
    """Session temp dir for remote clients, host output_dir for localhost."""
    sid = _get_session_id(request)
    if sid and not _client_is_local(request):
        sess = _ensure_session(sid, is_remote=True)
        if sess.get("dir"):
            return str(sess["dir"])
    eng = get_engine()
    return (eng.config.output_dir or "").strip() or AppConfig().output_dir


def _cleanup_stale_sessions() -> None:
    """Delete session temp dirs older than _SESSION_MAX_AGE."""
    now = _time.time()
    stale: list[str] = []
    with _session_lock:
        for sid, info in list(_sessions.items()):
            if now - info.get("touched", info["created"]) > _SESSION_MAX_AGE:
                stale.append(sid)
        for sid in stale:
            info = _sessions.pop(sid, None)
            if info and info.get("dir"):
                try:
                    shutil.rmtree(info["dir"], ignore_errors=True)
                except OSError:
                    pass
    if stale:
        _logger(f"[SESSION] Cleaned up {len(stale)} stale remote session(s).")


def _is_localhost(host: str | None) -> bool:
    if not host:
        return False
    h = host.lower().strip()
    if h in ("127.0.0.1", "::1", "localhost"):
        return True
    if h.startswith("127."):
        return True
    if h.startswith("::ffff:127."):
        return True
    return False


def _is_proxied(request: Request) -> bool:
    """True when the request arrived via a reverse proxy / tunnel (Cloudflare, ngrok, nginx…).

    cloudflared adds CF-Connecting-IP; most proxies add X-Forwarded-For.
    When present the TCP peer is the proxy (127.0.0.1), not the real client.
    """
    return bool(
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for")
        or request.headers.get("x-real-ip")
    )


def _client_is_local(request: Request) -> bool:
    """True only when the *real* client is on the same machine (not tunnelled)."""
    if _is_proxied(request):
        return False
    host = request.client.host if request.client else None
    return _is_localhost(host)


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _lan_enabled() -> bool:
    return _truthy_env("SAMSEL_AUTOMIX_LAN")


def _allow_remote() -> bool:
    """Internet / Cloudflare Tunnel — use with SAMSEL_AUTOMIX_TOKEN unless NO_TOKEN is set."""
    return _truthy_env("SAMSEL_AUTOMIX_ALLOW_REMOTE")


def _no_token_mode() -> bool:
    """Skip token checks (still gated by LAN / ALLOW_REMOTE for non-localhost)."""
    return _truthy_env("SAMSEL_AUTOMIX_NO_TOKEN")


def _is_rfc1918_host(host: str | None) -> bool:
    if not host:
        return False
    h = host.lower().strip()
    if h.startswith("::ffff:"):
        h = h[7:]
    parts = h.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b, c, d = (int(x) for x in parts)
    except ValueError:
        return False
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    if a == 100 and 64 <= b <= 127:
        return True
    if a == 169 and b == 254:
        return True
    return False


def _expected_token() -> str:
    return os.environ.get("SAMSEL_AUTOMIX_TOKEN", "").strip()


def _token_provided(request: Request) -> str:
    q = (request.query_params.get("token") or "").strip()
    if q:
        return q
    h = (request.headers.get("x-samsel-automix-token") or "").strip()
    if h:
        return h
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


def require_automix_client(request: Request) -> None:
    host = request.client.host if request.client else None
    if _is_localhost(host) and not _is_proxied(request):
        return

    no_tok = _no_token_mode()
    exp = _expected_token()
    on_private_lan = _is_rfc1918_host(host) and not _is_proxied(request)

    if no_tok:
        if (on_private_lan and _lan_enabled()) or _allow_remote():
            return
        raise HTTPException(
            status_code=403,
            detail=(
                "AutoMix (no-token mode): enable SAMSEL_AUTOMIX_LAN=1 for home Wi‑Fi, or "
                "SAMSEL_AUTOMIX_ALLOW_REMOTE=1 for Cloudflare / internet."
            ),
        )

    if on_private_lan and _lan_enabled():
        if exp and _token_provided(request) != exp:
            raise HTTPException(
                status_code=403,
                detail="Missing or wrong AutoMix token.",
            )
        return

    if _allow_remote():
        if not exp:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Internet / Cloudflare access needs SAMSEL_AUTOMIX_TOKEN on the server. "
                    "Set a strong secret, restart uvicorn, then enter it under “LAN token” in this app."
                ),
            )
        if _token_provided(request) != exp:
            raise HTTPException(
                status_code=403,
                detail="Missing or wrong AutoMix token.",
            )
        return

    if _lan_enabled():
        if exp and _token_provided(request) != exp:
            raise HTTPException(
                status_code=403,
                detail="Missing or wrong AutoMix token.",
            )
        return

    raise HTTPException(
        status_code=403,
        detail=(
            "AutoMix blocked: use SAMSEL_AUTOMIX_LAN=1 for home Wi‑Fi, or "
            "SAMSEL_AUTOMIX_ALLOW_REMOTE=1 plus SAMSEL_AUTOMIX_TOKEN for Cloudflare / internet "
            "(or SAMSEL_AUTOMIX_NO_TOKEN=1 with ALLOW_REMOTE — insecure)."
        ),
    )


LC = [Depends(require_automix_client)]

_OUTPUT_LIST_EXTS = set(SUPPORTED_AUDIO_EXTS) | {".lrc"}
_OUTPUT_LIST_LIMIT = 120
# Hide m4a/webm in API lists when a same-stem .mp3 exists (avoids wrong download before cleanup runs).
_INTERMEDIATE_AUDIO_EXTS = frozenset({".m4a", ".webm", ".opus", ".aac", ".ogg"})


def _filter_hide_intermediate_audio_if_mp3_exists(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stems: set[str] = set()
    for it in items:
        rel = (it.get("relpath") or "").replace("\\", "/").strip()
        if not rel:
            continue
        p = Path(rel)
        if p.suffix.lower() == ".mp3":
            stems.add(f"{p.parent.as_posix().lower()}:{p.stem.lower()}")
    out: list[dict[str, Any]] = []
    for it in items:
        rel = (it.get("relpath") or "").replace("\\", "/").strip()
        p = Path(rel)
        suf = p.suffix.lower()
        if suf in _INTERMEDIATE_AUDIO_EXTS:
            key = f"{p.parent.as_posix().lower()}:{p.stem.lower()}"
            if key in stems:
                continue
        out.append(it)
    return out


def _safe_path_under_root(root: Path, rel: str) -> Path | None:
    if not rel or len(rel) > 600:
        return None
    rel = rel.replace("\\", "/").strip()
    if rel.startswith(("/", "\\")) or ".." in Path(rel).parts:
        return None
    try:
        base = root.resolve()
        candidate = (base / rel).resolve()
        candidate.relative_to(base)
    except (ValueError, OSError):
        return None
    if not candidate.is_file():
        return None
    return candidate


_FILE_STABLE_AGE = 5.0  # seconds since last write before a file is considered "ready"


def _list_output_files(output_dir: str, *, require_stable: bool = False) -> list[dict[str, Any]]:
    root = Path(output_dir).expanduser()
    try:
        root = root.resolve()
    except OSError:
        return []
    if not root.is_dir():
        return []
    now = _time.time()
    found: list[tuple[Path, float]] = []
    try:
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix.lower() not in _OUTPUT_LIST_EXTS:
                continue
            try:
                rel = p.relative_to(root).as_posix()
            except ValueError:
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            if require_stable and (now - st.st_mtime) < _FILE_STABLE_AGE:
                continue
            found.append((p, st.st_mtime))
    except OSError:
        return []
    found.sort(key=lambda x: -x[1])
    items: list[dict[str, Any]] = []
    for p, mtime in found[:_OUTPUT_LIST_LIMIT]:
        try:
            rel = p.relative_to(root).as_posix()
            sz = p.stat().st_size
        except OSError:
            continue
        items.append(
            {
                "name": p.name,
                "relpath": rel,
                "size": sz,
                "mtime": mtime,
            }
        )
    return items


@router.get("/info")
def automix_info():
    """Public: lets phones discover LAN + token requirements before calling protected routes."""
    no_tok = _no_token_mode()
    exp_str = _expected_token()
    exp = bool(exp_str)
    remote = _allow_remote()
    token_required = bool(exp_str) and not no_tok
    return {
        "ok": True,
        "lan_enabled": _lan_enabled(),
        "allow_remote": remote,
        "no_token_mode": no_tok,
        "token_required": token_required,
        "remote_misconfigured": remote and not exp and not no_tok,
    }


def _logger(msg: str) -> None:
    line = f"[{ts()}] {msg}"
    with _lock:
        _log_deque.append(line)


def _progress(pct: float, eta: str) -> None:
    with _lock:
        _live["progress"] = float(pct)
        _live["eta"] = eta or ""
        _live["status"] = f"Running… {pct:.1f}%"


def _sync_live_header_from_jobs() -> None:
    """Keep progress bar / status line in sync with job table (not stuck on 'Running… 100%')."""
    jobs = list(_live.get("jobs", []))
    if not jobs:
        _live["status"] = "Ready"
        _live["progress"] = 0.0
        _live["eta"] = ""
        return

    if any(j.get("status") == "Running" for j in jobs):
        return

    if any(j.get("status") == "Queued" for j in jobs):
        nq = sum(1 for j in jobs if j.get("status") == "Queued")
        _live["status"] = f"Queued — {nq} job(s) waiting"
        _live["progress"] = 0.0
        _live["eta"] = ""
        return

    failed = sum(1 for j in jobs if j.get("status") == "Failed")
    stopped = sum(1 for j in jobs if j.get("status") == "Stopped")
    completed = sum(1 for j in jobs if j.get("status") == "Completed")
    _live["eta"] = ""
    _live["progress"] = 0.0
    if failed == 0 and stopped == 0 and completed == len(jobs) and completed > 0:
        _live["status"] = "Completed — all jobs finished" if len(jobs) > 1 else "Completed"
        return
    parts: list[str] = []
    if completed:
        parts.append(f"{completed} completed")
    if failed:
        parts.append(f"{failed} failed")
    if stopped:
        parts.append(f"{stopped} stopped")
    _live["status"] = "Done — " + ", ".join(parts) if parts else "Done"


def _on_table() -> None:
    with _lock:
        if _engine is not None:
            _live["jobs"] = [asdict(j) for j in _engine.jobs.values()]
            th = _engine.worker_thread
            _live["worker_alive"] = bool(th and th.is_alive())
        _sync_live_header_from_jobs()


def get_engine() -> DownloaderEngine:
    global _engine
    with _lock:
        if _engine is None:
            cfg = AppConfig.load()
            _engine = DownloaderEngine(cfg, _logger, _progress, _on_table)
            _logger("[WEB] Engine ready — background worker started (same as desktop app on open).")
            _engine.start()
            _on_table()
        return _engine


def _snapshot() -> dict[str, Any]:
    with _lock:
        jobs = list(_live.get("jobs", []))
        worker_processing = any(j.get("status") == "Running" for j in jobs)
        return {
            "logs": list(_log_deque)[-400:],
            "jobs": jobs,
            "progress": _live["progress"],
            "eta": _live["eta"],
            "status": _live["status"],
            "worker_alive": _live.get("worker_alive", False),
            "worker_processing": worker_processing,
        }


class JobCreate(BaseModel):
    source: str = Field(..., min_length=1)
    source_type: Literal["single", "playlist", "csv", "folder_scan"]


class ConfigUpdate(BaseModel):
    output_dir: str | None = None
    audio_format: str | None = None
    audio_quality: str | None = None
    embed_thumbnail: bool | None = None
    add_metadata: bool | None = None
    fetch_lyrics: bool | None = None
    embed_lyrics_in_mp3: bool | None = None
    uslt_embed_full_lrc: bool | None = None
    detect_bpm: bool | None = None
    detect_genre: bool | None = None
    auto_import_library: bool | None = None
    playlist_subfolders: bool | None = None
    overwrite_files: bool | None = None
    ffmpeg_path: str | None = None


class DownloadZipBody(BaseModel):
    """Relative paths under the output folder (same as /outputs items)."""

    relpaths: list[str] = Field(..., min_length=1, max_length=_OUTPUT_LIST_LIMIT)


@router.get("/status", dependencies=LC)
def automix_status():
    return {
        "ok": True,
        "script": str(AUTOMIX_SCRIPT),
        "installed": AUTOMIX_SCRIPT.is_file(),
        "core": str((_BASE / "automix_core.py").resolve()),
    }


@router.post("/launch", dependencies=LC)
def automix_launch():
    if not AUTOMIX_SCRIPT.is_file():
        raise HTTPException(status_code=503, detail="AutoMix_DownLoader_v2.py not found on the server.")
    try:
        cmd = [sys.executable, str(AUTOMIX_SCRIPT)]
        kwargs: dict = {"cwd": str(AUTOMIX_CWD)}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(cmd, **kwargs)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True, "message": "Desktop AutoMix window started on this computer."}


@router.get("/config", dependencies=LC)
def get_config():
    eng = get_engine()
    return {"ok": True, "config": asdict(eng.config)}


@router.post("/config", dependencies=LC)
def post_config(body: ConfigUpdate):
    eng = get_engine()
    cfg = eng.config
    data = body.model_dump(exclude_unset=True)
    known = {f.name for f in fields(AppConfig)}
    for key, val in data.items():
        if key in known:
            setattr(cfg, key, val)
    if cfg.output_dir:
        ensure_dir(cfg.output_dir)
    cfg.save()
    _on_table()
    return {"ok": True, "config": asdict(cfg)}


@router.post("/job", dependencies=LC)
def create_job(body: JobCreate, request: Request):
    eng = get_engine()
    src = body.source.strip()
    if not src:
        raise HTTPException(status_code=400, detail="Empty source")
    out_override = ""
    sid = _get_session_id(request)
    if sid and not _client_is_local(request):
        sess = _ensure_session(sid, is_remote=True)
        if sess.get("dir"):
            out_override = str(sess["dir"])
    eng.enqueue_source(src, body.source_type, output_dir_override=out_override)
    _on_table()
    _cleanup_stale_sessions()
    return {"ok": True}


@router.post("/job/csv", dependencies=LC)
async def create_job_csv(request: Request, file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Upload a .csv file")
    ensure_dir(str(_UPLOADS))
    dest = _UPLOADS / f"{uuid.uuid4().hex}.csv"
    raw = await file.read()
    dest.write_bytes(raw)
    eng = get_engine()
    out_override = ""
    sid = _get_session_id(request)
    if sid and not _client_is_local(request):
        sess = _ensure_session(sid, is_remote=True)
        if sess.get("dir"):
            out_override = str(sess["dir"])
    eng.enqueue_csv(str(dest.resolve()), output_dir_override=out_override)
    _on_table()
    return {"ok": True, "saved": str(dest)}


@router.post("/worker/start", dependencies=LC)
def worker_start():
    get_engine().start()
    _on_table()
    with _lock:
        _live["status"] = "Worker started"
    return {"ok": True}


@router.post("/worker/stop", dependencies=LC)
def worker_stop():
    get_engine().stop()
    _on_table()
    with _lock:
        _live["status"] = "Stop requested"
    return {"ok": True}


@router.get("/outputs", dependencies=LC)
def list_outputs(request: Request):
    """Audio + .lrc under the output folder (session temp dir for remote clients)."""
    out = _output_dir_for_request(request)
    items = _filter_hide_intermediate_audio_if_mp3_exists(
        _list_output_files(out, require_stable=True)
    )
    return {"ok": True, "output_dir": out, "items": items}


def _unlink_temp_zip(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


@router.post("/download-zip", dependencies=LC)
def download_outputs_zip(body: DownloadZipBody, request: Request):
    """
    One .zip of many outputs — works on every mobile browser; user saves the file then picks a folder
    in the system Files app (Share → Save to Files on iOS) or extracts there.
    """
    out = _output_dir_for_request(request)
    root = Path(out).expanduser()
    try:
        root = root.resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Bad output folder: {e}") from e

    fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    added = 0
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for rel in body.relpaths:
                rel = (rel or "").strip()
                if not rel or len(rel) > 600 or ".." in Path(rel).parts:
                    continue
                path = _safe_path_under_root(root, rel)
                if path is None:
                    continue
                zf.write(path, arcname=rel.replace("\\", "/"))
                added += 1
    except Exception:
        _unlink_temp_zip(tmp_path)
        raise

    if added == 0:
        _unlink_temp_zip(tmp_path)
        raise HTTPException(status_code=404, detail="No files matched for ZIP (check list / paths).")

    return FileResponse(
        tmp_path,
        filename="automix_outputs.zip",
        media_type="application/zip",
        content_disposition_type="attachment",
        background=BackgroundTask(_unlink_temp_zip, tmp_path),
        headers={
            "Cache-Control": "private, no-store, no-transform",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/download", dependencies=LC)
def download_output_file(
    request: Request,
    relpath: str = Query(..., min_length=1, max_length=600, description="Path under output folder, posix relative"),
):
    out = _output_dir_for_request(request)
    root = Path(out).expanduser()
    try:
        root = root.resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Bad output folder: {e}") from e
    path = _safe_path_under_root(root, relpath)
    if path is None:
        raise HTTPException(status_code=404, detail="File not found or not under output folder")
    try:
        age = _time.time() - path.stat().st_mtime
    except OSError:
        age = 999
    if age < _FILE_STABLE_AGE:
        raise HTTPException(status_code=409, detail="File still being processed — retry in a few seconds")
    mime, _ = mimetypes.guess_type(path.name)
    return FileResponse(
        path,
        filename=path.name,
        media_type=mime or "application/octet-stream",
        content_disposition_type="attachment",
        headers={
            "Cache-Control": "private, no-store, no-transform",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/open-output", dependencies=LC)
def open_output_folder():
    eng = get_engine()
    path = (eng.config.output_dir or "").strip() or AppConfig().output_dir
    ensure_dir(path)
    try:
        if sys.platform == "win32":
            os.startfile(path)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}


@router.get("/probe", dependencies=LC)
def probe_tools():
    ytdlp = find_executable("yt_dlp", "yt-dlp")
    synced = find_executable("syncedlyrics", "syncedlyrics")
    try:
        import mutagen  # noqa: F401

        mutagen_ok = True
    except Exception:
        mutagen_ok = False
    librosa_ok = _ac.librosa is not None and _ac.np is not None
    eng = get_engine()
    ff_dir = resolve_ffmpeg_dir(eng.config.ffmpeg_path or "")
    return {
        "ok": True,
        "yt_dlp": ytdlp,
        "syncedlyrics": synced,
        "mutagen": mutagen_ok,
        "librosa": librosa_ok,
        "ffmpeg_dir": ff_dir,
    }


@router.post("/log/clear", dependencies=LC)
def clear_automix_log():
    """Clear the in-memory live log (same session as SSE/snapshot)."""
    with _lock:
        _log_deque.clear()
    return {"ok": True}


def _merge_pending_files_into_snap(snap: dict[str, Any], request: Request) -> None:
    """Remote sessions: attach files waiting in the session temp dir (same for snapshot + SSE)."""
    sid = _get_session_id(request)
    if sid and not _client_is_local(request) and sid in _sessions:
        sess = _sessions[sid]
        if sess.get("dir") and sess["is_remote"]:
            snap["pending_files"] = _filter_hide_intermediate_audio_if_mp3_exists(
                _list_output_files(str(sess["dir"]), require_stable=True)
            )


@router.get("/snapshot", dependencies=LC)
def automix_snapshot(request: Request):
    """Same payload as SSE events — used by phones where EventSource is unreliable.

    For remote sessions: includes ``pending_files`` so the browser can auto-download
    completed outputs without the user having to tap Refresh → Save manually.
    """
    snap = _snapshot()
    _merge_pending_files_into_snap(snap, request)
    return snap


class AckFilesBody(BaseModel):
    relpaths: list[str] = Field(..., min_length=1, max_length=_OUTPUT_LIST_LIMIT)


def _ack_delete_delay_sec() -> float:
    try:
        return max(30.0, float(os.environ.get("SAMSEL_AUTOMIX_ACK_DELETE_DELAY_SEC", "180")))
    except ValueError:
        return 180.0


def _delete_session_files_later(root: Path, rels: list[str]) -> None:
    """Unlink after a delay so mobile / tunnel downloads can finish reading the file."""

    def run() -> None:
        try:
            _pending_ack_delete_timers.remove(timer_ref[0])  # type: ignore[name-defined]
        except (ValueError, KeyError, IndexError):
            pass
        for rel in rels:
            p = _safe_path_under_root(root, rel)
            if p is None:
                continue
            try:
                p.unlink()
                analysis = p.with_suffix(".analysis.json")
                if analysis.is_file():
                    analysis.unlink(missing_ok=True)
            except OSError:
                pass
        for d in sorted(root.rglob("*"), reverse=True):
            if d.is_dir():
                try:
                    d.rmdir()
                except OSError:
                    pass

    timer_ref: list[threading.Timer] = []
    t = threading.Timer(_ack_delete_delay_sec(), run)
    t.daemon = True
    timer_ref.append(t)
    _pending_ack_delete_timers.append(t)
    t.start()


@router.post("/session/ack", dependencies=LC)
def ack_delivered_files(body: AckFilesBody, request: Request):
    """Phone calls this after auto-downloading files; the server deletes them from the
    session temp dir so they don't pile up on the host.

    Deletion is delayed (default 180s) so the HTTP response is not cut off mid-transfer
    (which produced ~1-minute truncated MP3s on slow links / Cloudflare tunnels).
    """
    sid = _get_session_id(request)
    if not sid or _client_is_local(request) or sid not in _sessions:
        return {"ok": True, "scheduled": 0, "delete_after_sec": 0}
    sess = _sessions.get(sid)
    if not sess or not sess.get("dir"):
        return {"ok": True, "scheduled": 0, "delete_after_sec": 0}
    root = Path(sess["dir"])
    rels = [r for r in body.relpaths if r and isinstance(r, str)]
    if not rels:
        return {"ok": True, "scheduled": 0, "delete_after_sec": 0}
    _delete_session_files_later(root, rels)
    delay = _ack_delete_delay_sec()
    return {"ok": True, "scheduled": len(rels), "delete_after_sec": delay}


@router.get("/stream", dependencies=LC)
async def automix_stream(request: Request):
    async def gen():
        while True:
            snap = _snapshot()
            _merge_pending_files_into_snap(snap, request)
            line = json.dumps(snap, ensure_ascii=False)
            yield f"data: {line}\n\n".encode("utf-8")
            await asyncio.sleep(0.35)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
