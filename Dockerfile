# SAMSEL Web on Railway (FastAPI + static + AutoMix; ffmpeg for yt-dlp)
FROM python:3.11-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Slim deps for small Railway instances (avoids OOM during boot). Full stack: use requirements.txt.
COPY requirements-docker.txt requirements-docker.txt
RUN pip install --no-cache-dir -r requirements-docker.txt

COPY . .

# Fail the image build if the app cannot import (surfaces errors before deploy healthcheck).
RUN python -c "import server; print('server import ok')"

# Windows CRLF in repo can break shebang on Linux
RUN sed -i 's/\r$//' /app/docker/entrypoint.sh && chmod +x /app/docker/entrypoint.sh

# Railway injects PORT at runtime; entrypoint expands it reliably.
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
