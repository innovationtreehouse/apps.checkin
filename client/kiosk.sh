#!/usr/bin/env bash
# CheckMeIn Kiosk — start script for Raspberry Pi
# Run this from the client/ directory of the checkin monorepo.
set -e

# Ensure we're in the script's directory
cd "$(dirname "$0")"

while true; do
  # release-channel: tags
  # The kiosk runs the latest RELEASE, not main -- the server deploys from
  # release tags, so a Pi on main runs client code whose server counterpart is
  # not deployed. client.py picks the commit (resolve_update_target) so the
  # updater and the poller that triggers it cannot disagree about the target.
  # Operating on the monorepo root: this script lives in client/, so .git is one
  # level up. Nothing below may kill the kiosk under `set -e` -- a Pi that
  # cannot update must keep serving scans on the checkout it already has.
  ROOT="$(git rev-parse --show-toplevel)"
  echo "Fetching releases..."
  if git -C "$ROOT" fetch --tags --force origin main; then
    BEFORE="$(git -C "$ROOT" rev-parse HEAD)"
    TARGET="$(python3 -c 'import client; print(client.resolve_update_target())' || true)"
    if [ -n "$TARGET" ]; then
      echo "Updating to $TARGET"
      if git -C "$ROOT" checkout --detach "$TARGET"; then
        # Re-exec so the script running the loop is the one just checked out:
        # bash reads this file lazily, and the checkout may have rewritten the
        # bytes under it. Terminates -- the new process resolves the same
        # target, HEAD no longer moves, and it falls through.
        if [ "$BEFORE" != "$(git -C "$ROOT" rev-parse HEAD)" ]; then
          echo "Checkout moved; re-execing the updated kiosk.sh"
          exec "$0" "$@"
        fi
      else
        echo "WARNING: checkout of $TARGET failed -- kiosk will keep running the current checkout." >&2
      fi
    else
      echo "WARNING: could not resolve an update target -- kiosk will keep running the current checkout." >&2
    fi
  else
    echo "WARNING: git fetch failed -- kiosk will keep running the current checkout." >&2
  fi

  # Start the client backend
  echo "Starting kiosk client..."
  python3 client.py &
  CLIENT_PID=$!

  # Wait for the server to come up
  sleep 2

  # Open Chromium in kiosk mode
  PORT=$(python3 -c "import json; print(json.load(open('config.json')).get('listen_port', 8080))")
  echo "Opening kiosk browser on port $PORT"

  # Disable X11 screen blanking and power management (DPMS) so the screen stays on
  xset s noblank || true
  xset s off || true
  xset -dpms || true

  # Newer Pi OS uses 'chromium', older uses 'chromium-browser'
  if command -v chromium-browser &>/dev/null; then
    CHROME=chromium-browser
  elif command -v chromium &>/dev/null; then
    CHROME=chromium
  else
    echo "ERROR: No Chromium browser found" >&2
    exit 1
  fi

  start_chrome() {
    $CHROME \
      --kiosk \
      --noerrdialogs \
      --disable-infobars \
      --no-first-run \
      --disable-session-crashed-bubble \
      --password-store=basic \
      "http://localhost:${PORT}" &
    CHROME_PID=$!
  }

  rm -f .chromium-bounce
  start_chrome

  # Inner loop: bounce Chromium alone when client.py writes the sentinel.
  # os._exit(0) still kills CLIENT_PID and takes the outer cycle.
  while kill -0 "$CLIENT_PID" 2>/dev/null; do
    if [ -f .chromium-bounce ]; then
      rm -f .chromium-bounce
      echo "Chromium bounce requested"
      kill "$CHROME_PID" 2>/dev/null || true
      wait "$CHROME_PID" 2>/dev/null || true
      start_chrome
    fi
    sleep 2
  done
  echo "Client died, restarting kiosk loop..."
  kill "$CHROME_PID" 2>/dev/null || true
  wait "$CHROME_PID" 2>/dev/null || true
  sleep 2
done
