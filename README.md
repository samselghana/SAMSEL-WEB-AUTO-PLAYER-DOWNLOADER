# SAMSEL Web v2 — browser parity build

Standalone **static + FastAPI** app that mirrors **SAMSEL V3 PRO** features that can run in the browser. All audio is processed locally (Web Audio API); the Python server only serves files and `/api/health`.

## Run

```bash
cd samsel_web
py -3.10 -m pip install -r requirements.txt
py -3.10 -m uvicorn server:app --host 0.0.0.0 --port 8765
```

Open **http://127.0.0.1:8765/** · or use `run_web.bat` on Windows.

## Feature parity (vs `SAMSEL_V3_PRO.py`)

| Feature | Web |
|--------|-----|
| Playlist, play/pause/stop, prev/next, seek, volume | Yes |
| Repeat Off / All / One | Yes |
| 10-band EQ (30 Hz–18 kHz log, −12…+20 dB) on **main deck** | Yes |
| BPM from tags + fallback BPM for beat math | Yes |
| Hotcues 1–8 Set/Go (beat-quantized) | Yes |
| Manual loop In/Out/Clear | Yes |
| Beat loop / Roll (1…64 beats), slip timeline on Roll Off | Yes |
| Crossfade into next track (seconds, equal-power option) | Yes (deck B dry; no EQ on overlap deck) |
| Jingle overlay / replace + volume | Yes |
| LRC lyrics, offset ms, highlight | Yes (load file, paste, or drop matching `.lrc` with audio) |
| Silence trim → WAV download | Yes (threshold + pad) |
| Metadata (ID3 via jsmediatags) | Yes |
| Output device picker | Experimental (`setSinkId`, Chromium) |

## Not identical to desktop (by design / platform limits)

- **RAM EQ decode path**, **QAudioSink**, and **exact** Windows/Qt device routing — not applicable in browser.
- **Lyrics download** from internet APIs (CORS) — use **Load .lrc** or paste instead.
- **Silence trimmer** batch jobs, **BPM auto-sort playlist**, **network** features — not ported.
- **Dual-deck EQ** on crossfade: overlap deck is **without** the 10-band chain (short overlap only).

## Offline

Prefer serving over `http://localhost` so **jsmediatags** CDN loads. You can open `static/index.html` via `file://` with limitations.
