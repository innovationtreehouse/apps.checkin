#!/usr/bin/env python3
"""
CheckMeIn Kiosk Client

A thin client for Raspberry Pi that:
  1. Serves a transparent reverse proxy on localhost:8083
  2. Wraps the Next.js frontend in an iframe at GET / pointing to kiosk_path
  3. Injects Ed25519 signature headers automatically into proxied API requests
  4. Listens for USB barcode/QR scanner input

Every scan goes straight to the server and the screen shows what the server
said. The kiosk keeps no roster, no queue and no close state of its own.
"""

import html
import json
import os
import secrets
import subprocess
import sys
import time
import threading
import logging
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from nacl.signing import SigningKey
import requests

from health import health_monitor
import spec_trace

CLOCK_INTERVAL_S = 30


def local_clock_label(now=None):
    """The Pi's local time and zone as this process sees them, so a Pi on the
    wrong timezone is visible on the door screen."""
    now = now or datetime.now().astimezone()
    return now.strftime("%H:%M %Z (UTC%z)")


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("kiosk")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
# The backend page serving the kiosk display; `mode=kiosk` selects its kiosk
# layout. Overridable per-Pi via config.json.
DEFAULT_KIOSK_PATH = "/attendance/current?mode=kiosk"

# Self-update loop guard (see self_update_poller): remote head we already exited
# for. Relative path -- kiosk.sh cds into client/ before launching client.py.
SELF_UPDATE_STATE_FILE = ".self_update_last_target"

# The kiosk tracks releases, not main. The server deploys from release tags, so
# a Pi following main runs client code whose server counterpart is not deployed
# yet -- that skew is what this channel exists to close.
RELEASE_TAG_GLOB = "v[0-9]*"

# A release is adopted only if its own kiosk.sh tracks releases too. The marker
# is that line, in this file's sibling script. Without the gate the changeover
# oscillates: the newest release still pulls main, so a Pi that checked it out
# would be pulled straight back to main, and back to the release, once per poll
# -- restarting the kiosk every time. Until a release carries the marker the
# channel stays on main, exactly as before.
RELEASE_CHANNEL_MARKER = "release-channel: tags"

def load_config(path="config.json"):
    if not os.path.exists(path):
        log.error(f"Config file not found: {path}")
        sys.exit(1)
    with open(path) as f:
        return json.load(f)

# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------
def load_signing_key(path):
    with open(path, "rb") as f:
        seed = f.read()
    return SigningKey(seed)

def build_signed_message(timestamp, nonce, method, path, body):
    # The wire contract with the server's verifyKioskSignature. Pinned by the
    # golden vector in kiosk-signing-vector.test.json, which both this client's
    # test_signing_vector.py and the server's verifyKioskSignature test read.
    return f"{timestamp}:{nonce}:{method}:{path}:{body}".encode()

def sign_request(signing_key, method, path, body=""):
    # Nonce is bound into the signed message and is single-use server-side, so a
    # captured request can't be replayed within the 60s timestamp window.
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    message = build_signed_message(timestamp, nonce, method, path, body)
    signature = signing_key.sign(message).signature.hex()
    return {
        "X-Kiosk-Timestamp": timestamp,
        "X-Kiosk-Nonce": nonce,
        "X-Kiosk-Signature": signature,
    }

# ---------------------------------------------------------------------------
# Backend communication & State
# ---------------------------------------------------------------------------
def _json_object(response):
    """(body, True) when the answer is a JSON object, else (None, False).

    What answers the kiosk is not always the server: the waker serves HTML, a
    captive portal serves its own JSON, and either can put 200 on it. Everything
    past this point reads the body as a dict, so a bare `null` or a list has to
    be turned back into an error here rather than crashing the thread that read
    it."""
    try:
        body = response.json()
    except ValueError:
        return None, False
    return (body, True) if isinstance(body, dict) else (None, False)


class BackendClient:
    def __init__(self, base_url, signing_key, attendance_path=None):
        self.base_url = base_url.rstrip("/")
        self.signing_key = signing_key
        self.attendance_path = attendance_path
        self.session = requests.Session()

    def _headers(self, method, path, body=""):
        h = sign_request(self.signing_key, method, path, body)
        h["Content-Type"] = "application/json"
        return h

    def post_scan(self, participant_id):
        """The badge, and nothing else: the server decides the direction and
        every consequence of it."""
        path = "/api/scan"
        payload = {}
        try:
            payload["participantId"] = int(participant_id)
        except ValueError:
            payload["participantId"] = participant_id
        body = json.dumps(payload)

        headers = self._headers("POST", path, body)
        try:
            r = self.session.post(
                self.base_url + path, headers=headers, data=body, timeout=10
            )
        except Exception as e:
            log.error(f"Failed to post scan: {e}")
            return {"error": str(e)}, 0

        body, readable = _json_object(r)
        if not readable:
            # The waker's HTML on a cold wake, or a captive portal. Nothing was
            # acknowledged whatever status rode with it, so this reports no
            # status at all: a gateway's 200 must never read as a recorded scan.
            log.warning(f"Unreadable scan reply (HTTP {r.status_code})")
            return {"error": "Server not ready — scan not recorded"}, 0
        return body, r.status_code

    def get_attendance(self):
        if not self.attendance_path:
            return {"error": "no attendance_path configured"}, 0
        path = self.attendance_path
        headers = self._headers("GET", path)
        try:
            r = self.session.get(
                self.base_url + path, headers=headers, timeout=10
            )
        except Exception as e:
            log.error(f"Failed to get attendance: {e}")
            return {"error": str(e)}, 0

        body, readable = _json_object(r)
        if not readable:
            log.warning(f"Unreadable roster reply (HTTP {r.status_code})")
            return {"error": "Unreadable roster reply"}, 0
        return body, r.status_code

    def get_ping(self):
        """What is deployed, and is anything worth fetching. The server answers
        this from its own memory, so the kiosk may ask as often as it likes; the
        `facility` block rides on the signature, since whether the building is
        empty is not public."""
        path = "/api/system-status/kiosk-version"
        headers = self._headers("GET", path)
        try:
            r = self.session.get(
                self.base_url + path, headers=headers, timeout=5
            )
        except Exception as e:
            log.error(f"Failed to ping the server: {e}")
            return {}, 0

        body, readable = _json_object(r)
        return (body, r.status_code) if readable else ({}, 0)


class AttendanceState:
    """What the kiosk needs to drive its own screen: the counts it last heard,
    the reader's repeat-read window, and the liveness marks the health monitor
    reads."""

    def __init__(self):
        self.lock = threading.Lock()
        self.subscribers = []  # list of queue.Queue for SSE clients
        self.current_counts = {"total": 0, "keyholders": 0, "volunteers": 0, "students": 0}
        self.last_read = {}          # participant id -> monotonic time of its last read
        self.last_browser_seen = time.monotonic()
        self.last_attendance_ok = None
        self.attendance_auth_fail = False
        self.scanner_ok = True

    def is_repeat_read(self, participant_id):
        """True for a read of this badge within REPEAT_READ_SECONDS of its last
        read: the scanner re-reading one touch, or a badge held to the reader.
        Every read becomes the latest, so the window slides while it is held."""
        pid = int(participant_id)
        now = time.monotonic()
        with self.lock:
            last = self.last_read.get(pid)
            self.last_read[pid] = now
            return last is not None and now - last < REPEAT_READ_SECONDS

    def subscribe(self):
        """Register a new SSE client, returns a Queue to read events from."""
        import queue
        q = queue.Queue()
        with self.lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q):
        """Remove an SSE client queue."""
        with self.lock:
            try:
                self.subscribers.remove(q)
            except ValueError:
                pass

    def push_event(self, event_data):
        """Push an event to all connected SSE clients."""
        with self.lock:
            for q in self.subscribers:
                q.put(event_data)

# ---------------------------------------------------------------------------
# Transparent Signing Proxy & Kiosk Handler
# ---------------------------------------------------------------------------
class KioskHandler(BaseHTTPRequestHandler):
    state = None
    backend = None
    kiosk_path = DEFAULT_KIOSK_PATH
    disable_blackout = False

    def do_GET(self):
        if self.state is not None:
            self.state.last_browser_seen = time.monotonic()
        if self.path == "/":
            self._serve_wrapper()
        elif self.path == "/events":
            self._serve_sse()
        else:
            self._proxy_request("GET")

    def do_POST(self): self._proxy_request("POST")
    def do_PUT(self): self._proxy_request("PUT")
    def do_DELETE(self): self._proxy_request("DELETE")
    def do_PATCH(self): self._proxy_request("PATCH")

    def _serve_wrapper(self):
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CheckMeIn — Kiosk</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body, html {{ width: 100%; height: 100%; overflow: hidden; background: #000; font-family: sans-serif; }}
  iframe {{ width: 100%; height: 100%; border: none; }}

  #blackout {{
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: #000;
    z-index: 10000;
    display: none;
    pointer-events: none;
  }}

  #flash-container {{
    position: absolute;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    width: 80%;
    max-width: 600px;
    pointer-events: none;
  }}
  .banner {{
    padding: 1.5rem;
    border-radius: 12px;
    margin-bottom: 1rem;
    font-weight: bold;
    font-size: 1.5rem;
    text-align: center;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    animation: fadeout 5s forwards;
  }}
  .banner-ok {{
    background: rgba(16,185,129,0.95);
    border: 2px solid #34d399;
    color: #fff;
  }}
  .banner-error {{
    background: rgba(239,68,68,0.95);
    border: 2px solid #f87171;
    color: #fff;
  }}
  .banner-warning {{
    background: rgba(245,158,11,0.95);
    border: 2px solid #fbbf24;
    color: #fff;
    white-space: pre-wrap;
    /* No fade: an amber banner stays fully legible for its whole dwell. */
    animation: none;
  }}
  #local-clock {{
    position: absolute;
    bottom: 12px;
    left: 12px;
    z-index: 9998;
    color: rgba(255,255,255,0.6);
    background: rgba(0,0,0,0.5);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 0.8rem;
    pointer-events: none;
  }}
  @keyframes fadeout {{
    0% {{ opacity: 1; }}
    80% {{ opacity: 1; }}
    100% {{ opacity: 0; display: none; }}
  }}
</style>
<script>
  let sleepTimeout = null;
  const disableBlackout = {str(self.disable_blackout).lower()};

  function setBlackout(visible) {{
    if (disableBlackout) return;
    const b = document.getElementById("blackout");
    if (visible) {{
      b.style.display = "block";
    }} else {{
      b.style.display = "none";
      if (sleepTimeout) {{
        clearTimeout(sleepTimeout);
        sleepTimeout = null;
      }}
    }}
  }}

  function handleData(data, isInitial) {{
    const counts = data.counts || {{}};
    const total = counts.total ?? -1;

    // Wake up on any activity
    if (!isInitial) setBlackout(false);

    if (total === 0) {{
      // Building is empty — sleep after 5s delay (so user can see banner)
      if (!sleepTimeout) {{
        sleepTimeout = setTimeout(() => {{
          setBlackout(true);
        }}, isInitial ? 0 : 5000);
      }}
    }} else if (total > 0) {{
      setBlackout(false);
    }}
  }}

  let bannerTimer = null;

  function connectSSE() {{
    const source = new EventSource("/events");

    source.addEventListener("status", function(e) {{
      const data = JSON.parse(e.data);
      handleData(data, true);
    }});

    // The Pi's local time as Python sees it.
    source.addEventListener("clock", function(e) {{
      document.getElementById("local-clock").textContent = JSON.parse(e.data).label;
    }});

    source.addEventListener("scan", function(e) {{
      const data = JSON.parse(e.data);
      if (data.reload) {{
        const iframe = document.querySelector("iframe");
        if (iframe) {{
          const u = new URL(iframe.src, window.location.origin);
          u.searchParams.set('_t', Date.now());
          iframe.src = u.toString();
        }}
        return;
      }}
      handleData(data, false);
      const html = data.html || "";
      if (html) {{
        const container = document.getElementById("flash-container");
        container.innerHTML = html;
        const banner = container.querySelector(".banner");
        if (banner) {{
          banner.style.animation = 'none';
          banner.offsetHeight;
          banner.style.animation = null;
        }}
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => {{ container.innerHTML = ''; }}, 12000);
      }}
      // Tell iframe to refresh attendance display with inline data
      const iframe = document.querySelector("iframe");
      if (iframe && iframe.contentWindow) {{
        if (data.attendance) {{
          iframe.contentWindow.postMessage({{type: "refresh-attendance", attendance: data.attendance, counts: data.counts, safety: data.safety}}, window.location.origin);
        }} else {{
          iframe.contentWindow.postMessage("refresh-attendance", window.location.origin);
        }}
      }}
    }});
    source.onerror = function() {{
      source.close();
      setTimeout(connectSSE, 3000);
    }};
  }}
</script>
</head>
<body onload="connectSSE()">
  <div id="blackout"></div>
  <div id="flash-container"></div>
  <div id="local-clock"></div>
  <iframe src="{self.kiosk_path}"></iframe>
</body>
</html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))

    def _serve_sse(self):
        """Server-Sent Events stream for pushing badge scan results to the browser."""
        import queue as queue_mod
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = self.state.subscribe()
        try:
            # Send initial status
            with self.state.lock:
                initial_status = json.dumps({"counts": self.state.current_counts})
            self.wfile.write(f"event: status\ndata: {initial_status}\n\n".encode())
            self.wfile.flush()

            last_clock = 0.0
            while True:
                # The clock event doubles as the keepalive that detects dead connections.
                if time.monotonic() - last_clock >= CLOCK_INTERVAL_S:
                    clock = json.dumps({"label": local_clock_label()})
                    self.wfile.write(f"event: clock\ndata: {clock}\n\n".encode())
                    self.wfile.flush()
                    last_clock = time.monotonic()
                try:
                    event_data = q.get(timeout=CLOCK_INTERVAL_S)
                    payload = json.dumps(event_data)
                    self.wfile.write(f"event: scan\ndata: {payload}\n\n".encode())
                    self.wfile.flush()
                except queue_mod.Empty:
                    pass
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.state.unsubscribe(q)

    def _proxy_request(self, method):
        url = self.backend.base_url + self.path

        body_bytes = b""
        length = int(self.headers.get("Content-Length", 0))
        if length > 0:
            body_bytes = self.rfile.read(length)

        req_headers = {}
        for k, v in self.headers.items():
            if k.lower() not in ['host', 'connection', 'accept-encoding']:
                req_headers[k] = v

        # Inject Key Signing Headers onto the API requests transparently!
        # Sign with pathname only (no query string) — backend verifies against pathname
        from urllib.parse import urlparse
        sign_path = urlparse(self.path).path

        body_str = ""
        if body_bytes:
            try:
                body_str = body_bytes.decode('utf-8')
            except UnicodeDecodeError:
                pass

        sig_headers = sign_request(self.backend.signing_key, method, sign_path, body_str)
        req_headers.update(sig_headers)

        try:
            # Use requests.request (stateless) so cookies flow directly between browser and backend
            resp = requests.request(
                method=method,
                url=url,
                headers=req_headers,
                data=body_bytes if body_bytes else None,
                allow_redirects=False,
                stream=True,
                timeout=30
            )

            if self.state is not None:
                self.state.last_browser_seen = time.monotonic()
                if sign_path == "/api/attendance":
                    if resp.status_code == 200:
                        self.state.last_attendance_ok = time.monotonic()
                        self.state.attendance_auth_fail = False
                    elif resp.status_code in (401, 403):
                        self.state.attendance_auth_fail = True

            try:
                self.send_response(resp.status_code)
                for k, v in resp.headers.items():
                    if k.lower() not in ['transfer-encoding', 'connection', 'content-encoding']:
                        self.send_header(k, v)
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError):
                return

            try:
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                # Browser closed the connection, normal for HMR or page reloads
                pass

        except Exception as e:
            if not isinstance(e, (BrokenPipeError, ConnectionResetError)):
                log.error(f"Proxy error for {self.path}: {e}")
            try:
                # If we haven't sent headers yet, try to send a 502
                self.send_response(502)
                self.end_headers()
            except Exception:
                pass

    def log_message(self, format, *args):
        pass

# ---------------------------------------------------------------------------
# USB scanner listener
# ---------------------------------------------------------------------------
def usb_scanner_listener(backend, state, device_path):
    try:
        import evdev
    except ImportError:
        log.warning("evdev not installed — USB scanner disabled")
        return

    def find_device(pattern):
        import evdev
        devices = [evdev.InputDevice(path) for path in evdev.list_devices()]
        # 1. Try exact path match
        for d in devices:
            if d.path == pattern:
                return d
        # 2. Try name match (case-insensitive substring)
        for d in devices:
            if pattern.lower() in d.name.lower():
                log.info(f"Found device '{d.name}' at {d.path} matching pattern '{pattern}'")
                return d
        return None

    KEY_MAP = {
        2: "1", 3: "2", 4: "3", 5: "4", 6: "5",
        7: "6", 8: "7", 9: "8", 10: "9", 11: "0",
    }
    ENTER_KEY = 28

    log.info(f"Attempting to open USB device: {device_path}")
    dev = None
    try:
        dev = find_device(device_path)
        if not dev and device_path.startswith("/dev/input/"):
            import evdev as _evdev
            dev = _evdev.InputDevice(device_path)
        if dev:
            dev.grab()
            log.info(f"Listening on: {dev.name} ({dev.path})")
            state.scanner_ok = True
        else:
            log.error(f"No device found matching: {device_path}")
            state.scanner_ok = False
    except Exception as e:
        log.error(f"Cannot open USB device {device_path}: {e}")
        state.scanner_ok = False

    backoff = 1.0
    while True:
        if dev is None:
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            try:
                dev = find_device(device_path)
                if not dev and device_path.startswith("/dev/input/"):
                    import evdev as _evdev
                    dev = _evdev.InputDevice(device_path)
                if not dev:
                    continue
                dev.grab()
                log.info(f"Re-grabbed scanner: {dev.name} ({dev.path})")
                state.scanner_ok = True
            except Exception as regrab_err:
                log.warning(f"Scanner re-grab failed: {regrab_err}")
                dev = None
                continue
        buffer = ""
        try:
            for event in dev.read_loop():
                backoff = 1.0
                state.scanner_ok = True
                if event.type != evdev.ecodes.EV_KEY:
                    continue
                key_event = evdev.categorize(event)
                if key_event.keystate != 1:
                    continue

                if key_event.scancode == ENTER_KEY:
                    if buffer.strip():
                        participant_id = buffer.strip()
                        log.info(f"Scanned ID: {participant_id}")
                        try:
                            handle_scan(backend, state, participant_id)
                        except Exception as scan_err:
                            # A failed scan is not a failed reader: without this
                            # the handler below would ungrab a healthy scanner.
                            log.warning(f"Scan failed: {scan_err}")
                    buffer = ""
                elif key_event.scancode in KEY_MAP:
                    buffer += KEY_MAP[key_event.scancode]
        except Exception as e:
            state.scanner_ok = False
            log.warning(f"Scanner lost ({e}); re-grab in {backoff:.0f}s")
            try:
                dev.ungrab()
            except Exception:
                pass
            try:
                dev.close()
            except Exception:
                pass
            dev = None

def stdin_scanner_listener(backend, state):
    log.info("USB device not configured — reading scans from stdin")
    while True:
        try:
            line = input()
            participant_id = line.strip()
            if participant_id:
                log.info(f"Stdin scan: {participant_id}")
                handle_scan(backend, state, participant_id)
        except EOFError:
            break
        except Exception as e:
            log.warning(f"Scan failed: {e}")

# Reads of one badge this close together are one scan (a scanner double-read).
REPEAT_READ_SECONDS = 3.0
CLOSING_ALONE_COPY = "You are closing the building. The building should be empty."


def _scan_result_banner_html(body, status):
    """The banner for one scan response."""
    # Build banner HTML for the wrapper page.
    # All values below originate from the backend response (participant names,
    # messages) and are ultimately assigned to the wrapper page via innerHTML.
    # Names are user-controlled (set via PATCH /api/profile), so every
    # interpolated value MUST be HTML-escaped to prevent stored XSS in the kiosk
    # browser — which can issue signed, kiosk-authenticated requests through the
    # local proxy. Escape before the newline->`<br>` substitution so injected
    # markup cannot survive.
    if status >= 400 or "error" in body:
        if body.get("type") == "warning":
            warn = html.escape(body.get("error", "Warning")).replace("\n", "<br>")
            return f'<div class="banner banner-warning">⚠️ {warn}</div>'
        err = html.escape(body.get("error", "Unknown error"))
        return f'<div class="banner banner-error">✗ Scan failed: {err}</div>'

    stype = body.get("type", "")
    # A park created no Visit, so it must not render as a check-in: the green
    # tick plus the "?" a park body has no name for reads as one at arm's
    # length. Amber says captured-but-not-complete -- recorded for review.
    if stype == "parked":
        parked = html.escape(body.get("message", "Recorded for review."))
        return f'<div class="banner banner-warning">✓ {parked}</div>'
    # The name the person goes by, resolved server-side by the same rule the kiosk
    # roster uses — nickname, else first name, else the part of the address before
    # the @. The raw address is never sent and never shown.
    who = html.escape(str(body.get("participant", {}).get("name") or "?"))
    msg = html.escape(body.get("message", ""))
    label = "CHECKED IN" if stype == "checkin" else "CHECKED OUT"
    if stype == "checkout" and body.get("facilityClosed"):
        return f'<div class="banner banner-ok">✓ {who} — {label}<br>🔒 {html.escape(CLOSING_ALONE_COPY)}</div>'
    warning = html.escape(body.get("warning", "")).replace("\n", "<br>")
    if warning:
        # Scan succeeded but the room is short of supervising adults: amber,
        # and it dwells longer than green. Still confirms the scan.
        return f'<div class="banner banner-warning">✓ {who} — {label}<br>⚠️ {warning}</div>'
    if msg and msg != "Checked in successfully" and msg != "Checked out successfully":
        return f'<div class="banner banner-ok">✓ {who} — {msg}</div>'
    return f'<div class="banner banner-ok">✓ {who} — {label}</div>'

# Server ids are Postgres int4. A longer read is two badges run together (a
# lost Enter) or a product barcode -- never a person, and must not be sent.
MAX_PARTICIPANT_ID = 2147483647

def _is_valid_participant_id(participant_id):
    raw = str(participant_id)
    return raw.isascii() and raw.isdigit() and 0 < int(raw) <= MAX_PARTICIPANT_ID

def handle_scan(backend, state, participant_id):
    """Send the badge and show the answer. An unreachable server is a failed
    scan: nothing is stored, and the screen says so."""
    if not _is_valid_participant_id(participant_id):
        log.warning(f"Rejected malformed scan: {participant_id!r}")
        state.push_event({"html": '<div class="banner banner-error">✗ Badge not read — please scan again</div>'})
        return
    if state.is_repeat_read(participant_id):
        # One touch the reader read twice, or a badge held to it: one scan.
        log.info(f"Ignored repeat read of {participant_id}")
        return

    spec_trace.emit("KioskBadge", p=str(participant_id))
    body, status = backend.post_scan(participant_id)
    recorded = 200 <= status < 300
    state.push_event({"html": _scan_result_banner_html(body, status)})

    if recorded:
        ptype = body.get("type", "?")
        who = body.get("participant", {}).get("name") or "?"
        log.info(f"Scan result: {ptype.upper()} — {who}")
    else:
        log.warning(f"Scan not recorded: {body.get('error', body)}")

    # Fetch fresh attendance and push update for the iframe
    if backend.attendance_path and recorded:
        push_roster(backend, state)

    spec_trace.emit("KioskScanResult", p=str(participant_id), status=status, type=body.get("type"))

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
# How often the kiosk asks the server whether anything changed. The server
# answers from memory, so the pace costs it no database work: it decides for
# itself when a poll is worth a query.
PING_INTERVAL_S = 1.0
# When the answer carries no facility block — an older server, or one that would
# not verify this signature — fall back to fetching the roster this often.
ROSTER_FALLBACK_S = 30.0


def push_roster(backend, state):
    """Fetch the server's roster and push it to the board."""
    att_data, att_status = backend.get_attendance()
    if att_status != 200:
        return
    if "counts" in att_data:
        with state.lock:
            state.current_counts = att_data["counts"]
    event = {"html": ""}
    for key in ("attendance", "counts", "safety"):
        if key in att_data:
            event[key] = att_data[key]
    state.push_event(event)


def ping_poller(backend, state, interval=PING_INTERVAL_S, fallback=ROSTER_FALLBACK_S,
                sleep_fn=time.sleep):
    """Ask the server, once a second, what is deployed and whether the roster
    moved. Waking the database is the server's call, not the kiosk's: the answer
    comes from the server's own memory, and the kiosk fetches the roster only
    when the server says its roster generation changed."""
    seen = {"version": None, "generation": None, "fetched_at": 0.0}
    while True:
        sleep_fn(interval)
        try:
            _ping_once(backend, state, seen, fallback)
        except Exception as e:
            # One odd answer must not take the loop with it: the board would
            # stop updating while the kiosk still looked alive.
            log.warning(f"Ping failed: {e}")


def _ping_once(backend, state, seen, fallback=ROSTER_FALLBACK_S):
    """One round of the ping loop. `seen` carries what the last round learned."""
    ping, status = backend.get_ping()
    if status != 200:
        return

    version = ping.get("version")
    if version and seen["version"] and version != seen["version"]:
        log.info(f"Server version changed from {seen['version']} to {version}. Requesting reload.")
        state.push_event({"reload": True})
    if version:
        seen["version"] = version

    if not backend.attendance_path:
        return
    facility = ping.get("facility")
    stale = time.monotonic() - seen["fetched_at"] >= fallback
    if isinstance(facility, dict):
        moved = facility.get("rosterGeneration")
        # An unmoved generation means nothing changed. While the building is
        # open, refresh on the fallback cadence anyway: the server's own cache
        # bounds its staleness the same way, and the database is already awake.
        if moved == seen["generation"] and not (facility.get("open") and stale):
            return
        seen["generation"] = moved
    elif not stale:
        return
    seen["fetched_at"] = time.monotonic()
    push_roster(backend, state)

def _read_last_restart_target(path=SELF_UPDATE_STATE_FILE):
    # Missing/unreadable file means "never restarted" -- same as no target.
    try:
        with open(path) as f:
            return f.read().strip() or None
    except OSError:
        return None

def _write_last_restart_target(remote_head, path=SELF_UPDATE_STATE_FILE):
    # True only once the sha reads back off disk; the caller must not exit
    # on False or the next boot forgets this attempt and loops.
    try:
        with open(path, "w") as f:
            f.write(remote_head)
    except OSError as e:
        log.warning(f"Could not persist self-update state to {path}: {e}")
        return False
    return _read_last_restart_target(path) == remote_head

def _should_restart_for_update(remote_head, last_restart_target):
    # False once we've already exited for this exact remote_head and the
    # restart didn't move HEAD onto it (the checkout failed); True for a
    # never-tried or newly-advanced target.
    return remote_head != last_restart_target

def fetch_update_refs(timeout=15):
    """Refresh both candidate targets. --force lets a moved tag land."""
    subprocess.run(
        ["git", "fetch", "--tags", "--force", "origin", "main"],
        capture_output=True, timeout=timeout,
    )

def latest_release_tag():
    """Highest release tag, or None. Sorted by version, not by tag date: a
    patch cut after a later minor must not outrank it."""
    out = subprocess.check_output(
        ["git", "tag", "-l", RELEASE_TAG_GLOB, "--sort=-v:refname"], text=True
    )
    tags = out.split()
    return tags[0] if tags else None

def _tracks_releases(ref):
    try:
        script = subprocess.check_output(
            ["git", "show", f"{ref}:client/kiosk.sh"],
            text=True, stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        return False
    return RELEASE_CHANNEL_MARKER in script

def resolve_update_target():
    """The commit this kiosk should be running. kiosk.sh checks this out and
    self_update_poller restarts when HEAD differs, so both read it from here and
    cannot disagree about where the Pi is meant to be."""
    tag = latest_release_tag()
    if tag and _tracks_releases(tag):
        return subprocess.check_output(
            ["git", "rev-list", "-n", "1", tag], text=True
        ).strip()
    return subprocess.check_output(
        ["git", "rev-parse", "origin/main"], text=True
    ).strip()

def self_update_poller(interval=60, state_path=SELF_UPDATE_STATE_FILE):
    """Background thread that restarts the client when the checkout should move
    to a newer release. Git only — it reaches no server."""
    last_restart_target = _read_last_restart_target(state_path)

    while True:
        time.sleep(interval)

        try:
            fetch_update_refs()

            local_head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
            remote_head = resolve_update_target()

            if local_head and remote_head and local_head != remote_head:
                if _should_restart_for_update(remote_head, last_restart_target):
                    if _write_last_restart_target(remote_head, state_path):
                        log.info(f"Client version update available ({local_head} -> {remote_head}). Restarting client.")
                        last_restart_target = remote_head
                        os._exit(0)
                    else:
                        # No target on disk means the next boot can't see this
                        # attempt, so exiting risks the loop. Stay up instead.
                        log.warning(
                            f"Could not record self-update target {remote_head} "
                            f"in {state_path}. Not restarting; staying on "
                            f"{local_head}."
                        )
                else:
                    # Restarted for this target already and HEAD didn't move --
                    # kiosk.sh's checkout failed. Stay up and keep serving
                    # scans on the current version instead of looping.
                    log.warning(
                        f"Still on {local_head}, HEAD did not advance to "
                        f"{remote_head} after a restart (kiosk.sh could not "
                        "check the target out: dirty tree, local changes, or "
                        "an unresolvable target). Not restarting again until "
                        "the checkout is fixed."
                    )
        except Exception as e:
            log.error(f"Error checking client version: {e}")

def main():
    config = load_config()
    backend_url = config["backend_url"]
    key_path = config.get("private_key_path", "./client.key")
    usb_device = config.get("usb_device", "")
    port = int(config.get("listen_port", 8080))
    kiosk_path = config.get("kiosk_path", DEFAULT_KIOSK_PATH)
    attendance_path = config.get("attendance_path", "")
    disable_blackout = config.get("disable_blackout", True)
    ping_interval = float(config.get("ping_interval", PING_INTERVAL_S))

    log.info(f"Backend: {backend_url}")
    log.info(f"Key:     {key_path}")
    log.info(f"USB:     {usb_device or '(stdin fallback)'}")
    log.info(f"Port:    {port}")
    log.info(f"Path:    {kiosk_path}")
    log.info(f"Attendance: {attendance_path or '(disabled)'}")
    log.info(f"Ping:    every {ping_interval:g}s")

    if not os.path.exists(key_path):
        log.error(f"Private key not found: {key_path}")
        sys.exit(1)
    signing_key = load_signing_key(key_path)

    backend = BackendClient(backend_url, signing_key, attendance_path or None)
    state = AttendanceState()

    # Fetch initial attendance state (only if attendance_path is configured).
    if attendance_path:
        log.info("Fetching initial attendance state...")
        att_data, att_status = backend.get_attendance()
        if att_status == 200 and "counts" in att_data:
            state.current_counts = att_data["counts"]
            log.info(f"Initial state: {state.current_counts['total']} people present")
        else:
            log.warning("Could not fetch initial attendance state")

    # Ask the server what changed; it decides what that costs it.
    pinger = threading.Thread(target=ping_poller, args=(backend, state),
                              kwargs={"interval": ping_interval}, daemon=True)
    pinger.start()

    # Start the self-update thread (git only; it reaches no server)
    updater = threading.Thread(target=self_update_poller, daemon=True)
    updater.start()

    allow_reboot = bool(config.get("allow_reboot", False))
    allow_wifi_bounce = bool(config.get("allow_wifi_bounce", False))
    hmon = threading.Thread(
        target=health_monitor,
        args=(backend_url, state),
        kwargs={"allow_reboot": allow_reboot, "allow_wifi_bounce": allow_wifi_bounce},
        daemon=True,
    )
    hmon.start()

    if usb_device:
        scanner = threading.Thread(target=usb_scanner_listener, args=(backend, state, usb_device), daemon=True)
    else:
        scanner = threading.Thread(target=stdin_scanner_listener, args=(backend, state), daemon=True)
    scanner.start()

    KioskHandler.state = state
    KioskHandler.backend = backend
    KioskHandler.kiosk_path = kiosk_path
    KioskHandler.disable_blackout = disable_blackout
    server = ThreadingHTTPServer(("127.0.0.1", port), KioskHandler)
    log.info(f"Proxy running on http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
        server.shutdown()

if __name__ == "__main__":
    main()
