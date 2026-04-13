# SAMSEL Web on Railway (FastAPI + static + AutoMix; ffmpeg for yt-dlp)
FROM python:3.11-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Railway sets PORT; default matches local dev fallback
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD sh -c 'uvicorn server:app --host 0.0.0.0 --port "${PORT:-8080}"'
