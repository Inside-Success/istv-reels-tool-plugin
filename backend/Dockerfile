# ISTV Reels backend.
#
# Build from the REPO ROOT, not from backend/:
#     docker build -f backend/Dockerfile -t istv-reels-backend .
#
# That is deliberate. backend/app.py puts the repo root on sys.path and imports
# src/ and generate_reels.py, so the build context has to include them. Copying
# only backend/ produces an image that fails at import.
#
# No ffmpeg in this image, on purpose: the only ffmpeg callers in the tree are
# src/audio_processor.py and src/camera_sync.py, neither of which the backend's
# import path reaches. Audio is already compressed by the time it arrives.

FROM python:3.11-slim

# Fail fast and log straight through to the platform's log collector.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first so edits to the source don't invalidate the layer.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# The modules the backend's import chain actually needs. Listing them explicitly
# rather than `COPY . .` keeps the image small and stops unrelated things (the
# plugin's vendored FFmpeg binaries, generated_data/, node_modules/) from
# silently ballooning it — premiere-plugin/vendor alone is ~420 MB.
COPY backend/            ./backend/
COPY src/                ./src/
COPY generate_reels.py export_pipeline.py paths.py ./

# Durable job state (SQLite). MOUNT A VOLUME HERE — the default path sits inside
# the image layer, so without one every restart loses in-flight jobs.
ENV ISTV_JOBS_DB=/data/jobs.db
RUN mkdir -p /data
VOLUME ["/data"]

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser /app /data
USER appuser

# Most PaaS hosts (Render, Cloud Run, Fly, Heroku) assign the port at runtime via
# $PORT and health-check that exact port; a hardcoded listener fails to start there.
# Default to 8722 so a plain `docker run -p 8722:8722` still works locally.
ENV PORT=8722
EXPOSE 8722

# /health is unauthenticated precisely so this works.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8722')}/health\",timeout=4).status==200 else 1)"

# ONE WORKER, ONE REPLICA. Job state is an in-process dict written through to
# SQLite, and startup resumes in-flight jobs — a second worker would resume the
# same jobs again and re-bill the Claude calls. Scaling out needs Redis first.
#
# Shell form so ${PORT} expands at runtime. exec keeps uvicorn as PID 1 so it
# receives SIGTERM directly and shuts down cleanly instead of being killed.
CMD ["sh", "-c", "exec uvicorn backend.app:app --host 0.0.0.0 --port ${PORT:-8722} --workers 1"]
