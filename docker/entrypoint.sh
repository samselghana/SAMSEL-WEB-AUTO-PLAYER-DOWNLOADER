#!/usr/bin/env sh
set -e
# Railway sets PORT; must expand at runtime (use shell, not bare JSON CMD without sh).
export PORT="${PORT:-8080}"
echo "[samsel] PORT=$PORT"
echo "[samsel] pwd=$(pwd) python=$(command -v python)"
test -f server.py || { echo "[samsel] FATAL: server.py missing — set Railway Root Directory to the folder that contains server.py + Dockerfile"; exit 1; }
exec python -m uvicorn server:app --host 0.0.0.0 --port "$PORT"
