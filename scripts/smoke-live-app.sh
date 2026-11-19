#!/usr/bin/env bash
# Probe a freshly deployed, scale-to-zero app until it answers for real.
#
#   scripts/smoke-live-app.sh <url>
#
# Passes on 200 or an auth redirect from the app itself. While the service
# wakes, the waker serves a "<service> is waking up" holding page with a 503;
# that page (any status) and any 503 are retried, as are the 502/504 the load
# balancer returns while tasks register and a failed connection (000) from a
# task slow to answer its first request. Anything else fails at once.
#
# Bound: 60 probes x 10s = 10 minutes. Task start to waker rule promote
# measures over 4 minutes, and a window that expires first reports a
# succeeded deploy as failed. Each probe also drives the waker's health poll,
# so keep the 10s cadence. SMOKE_INTERVAL overrides it for the self-test only.
set -uo pipefail
URL="${1:?usage: smoke-live-app.sh <url>}"
INTERVAL="${SMOKE_INTERVAL:-10}"
BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT

for i in $(seq 1 60); do
  : > "$BODY"
  CODE=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 10 "$URL") || CODE=000
  WAKING=no
  grep -qi 'waking up' "$BODY" && WAKING=yes
  echo "attempt $i: $URL -> HTTP $CODE (wake page: $WAKING)"
  if [ "$WAKING" = no ]; then
    case "$CODE" in
      200|301|302|307|308) echo "Smoke OK."; exit 0 ;;
      000|502|503|504) ;;
      *) echo "::error::Smoke test failed: $URL answered HTTP $CODE, not the app or its wake page"; exit 1 ;;
    esac
  fi
  sleep "$INTERVAL"
done
echo "::error::Smoke test failed: $URL was still waking (000/502/503/504) after 10 minutes"
exit 1
