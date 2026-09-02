# Build from the repo root (not from backend/), so the relative
# requirements include `../scripts/requirements.txt` still resolves:
#   docker build -f backend/Dockerfile -t sf-api .

# python:3.12-slim — see comment block after FROM for why not alpine/full.
FROM python:3.12-slim

# App + scripts live under /app so Config.PROJECT_ROOT (= backend's parent) is correct.
WORKDIR /app

# Don't write .pyc files into the image layers (noise; no speed win in containers).
ENV PYTHONDONTWRITEBYTECODE=1
# Flush stdout/stderr immediately so `docker logs` shows Flask output in real time.
ENV PYTHONUNBUFFERED=1
# Critical in Docker: 127.0.0.1 only accepts traffic inside this container.
# 0.0.0.0 accepts connections from other containers / published host ports.
ENV HOST=0.0.0.0
ENV PORT=5001
# Refresh is off by default; set DATA_REFRESH_HOURS>0 to enable (needs network).
ENV DATA_REFRESH_HOURS=0

# --- Dependency layer (cached until requirements*.txt change) ---
# Copy *only* the requirement files first. Docker hashes each COPY; if these
# two files are unchanged, it reuses the pip layer even when you edit Python code.
COPY backend/requirements.txt /app/backend/requirements.txt
# backend/requirements.txt contains `-r ../scripts/requirements.txt`, so that
# file must exist at the same relative path inside the image.
COPY scripts/requirements.txt /app/scripts/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# --- Application layer (invalidates on any backend/scripts code change) ---
COPY backend/ /app/backend/
# refresh_job.py shells out to scripts/refresh_data.py when DATA_REFRESH_HOURS>0.
# Without this COPY, enabling refresh would silently no-op ("script missing").
COPY scripts/ /app/scripts/

WORKDIR /app/backend

# EXPOSE is documentation + default for `docker run -P`. It does NOT open a
# host port by itself. Publishing is `docker run -p 5001:5001` (or compose ports).
EXPOSE 5001

# --no-debug: no reloader, no interactive debugger in a container.
CMD ["python", "run.py", "--no-debug"]
