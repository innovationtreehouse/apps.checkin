# The door kiosk's Python client. Chromium stays on the host; see the run flags
# and health check in README.md. Build from this directory: docker build client/
ARG PLATFORM=linux/arm64

FROM --platform=$PLATFORM public.ecr.aws/docker/library/python:3.11-slim-bookworm@sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd AS base

# evdev ships source only, so it compiles against the kernel input headers here.
FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM base
COPY --from=build /install /usr/local
# Named one by one so a local client.key or config.json can never enter a layer.
COPY client.py outbox.py health.py spec_trace.py healthcheck.py /app/
WORKDIR /app
# Fails the build if a module or evdev is missing. The compile step matters
# because the running root is read-only and cannot cache bytecode.
RUN python -c "import client, healthcheck, evdev" && python -m compileall -q /app

ENV PYTHONUNBUFFERED=1 KIOSK_CONTAINER=1
# The database, markers, key and config are all relative paths, so they resolve
# against the mounted host directory.
WORKDIR /data
USER 1000:1000
# As PID 1 Python ignores SIGTERM; SIGINT is what main() shuts down on.
STOPSIGNAL SIGINT
ENTRYPOINT ["python", "/app/client.py"]
