"""Local kiosk health probe, run inside the container by the host updater:
docker exec kiosk-client python /app/healthcheck.py
Exits 0 only when the running client's proxy answers, its database opens and it
holds the scanner. Talks to 127.0.0.1 only, so a server outage never fails it."""

import http.client
import json
import sys

HEALTH_PATH = "/local-health"
DEFAULT_PORT = 8080


def check(config_path="config.json"):
    """Returns the names of the failed checks; empty means healthy."""
    try:
        with open(config_path) as f:
            port = int(json.load(f).get("listen_port", DEFAULT_PORT))
    except (OSError, ValueError) as e:
        return [f"config ({e})"]
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", HEALTH_PATH)
        checks = json.loads(conn.getresponse().read())
    except (OSError, ValueError, http.client.HTTPException) as e:
        return [f"proxy ({e})"]
    return [name for name, ok in checks.items() if not ok]


if __name__ == "__main__":
    failed = check()
    if failed:
        print("unhealthy: " + ", ".join(failed), file=sys.stderr)
    sys.exit(1 if failed else 0)
