"""Trace recorder for validating the check-in TLA+ model against real kiosk
runs: one NDJSON line per model action point (badge, live send and result,
drain send and outcome). Only a test turns it on, with start(path); nothing in
the kiosk does, so a production kiosk records nothing."""

import json
import threading
import time

_lock = threading.Lock()
_sink = None


def start(path):
    """Test-only: record to `path`, or stop with None."""
    global _sink
    _sink = path


def on():
    """Whether a test is recording; callers skip building state snapshots otherwise."""
    return _sink is not None


def emit(name, **fields):
    if _sink is None:
        return
    line = {"tag": "trace", "ts": int(time.time() * 1000), "ns": time.monotonic_ns(),
            "event": {"name": name, **fields}}
    with _lock:
        with open(_sink, "a") as f:
            f.write(json.dumps(line) + "\n")
