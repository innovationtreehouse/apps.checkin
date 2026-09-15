#!/usr/bin/env python3
"""
CheckMeIn Kiosk Client

A thin client for Raspberry Pi that:
  1. Serves a transparent reverse proxy on localhost:8083
  2. Wraps the Next.js frontend in an iframe at GET / pointing to kiosk_path
  3. Injects Ed25519 signature headers automatically into proxied API requests
  4. Listens for USB barcode/QR scanner input
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
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from nacl.signing import SigningKey
import requests

from outbox import Outbox, classify_response, replay_drain, new_event_id, now_iso, in_closed_window
from health import health_monitor

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
DEFAULT_OUTBOX_PATH = "outbox.db"

# Self-update loop guard (see version_poller): remote head we already exited
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

    def post_scan(self, participant_id, force_close_token=None,
                  client_event_id=None, scanned_at=None, replay=False,
                  dead=False, dead_status=None, intent=None, clock_suspect=False,
                  force_close_confirmed=False):
        path = "/api/scan"
        payload = {"protocolVersion": SCAN_PROTOCOL_VERSION}
        try:
            payload["participantId"] = int(participant_id)
        except ValueError:
            payload["participantId"] = participant_id
        if force_close_token:
            payload["forceCloseToken"] = force_close_token
        if client_event_id:
            payload["clientEventId"] = client_event_id
        if scanned_at:
            payload["scannedAt"] = scanned_at
        if replay:
            # Only the outbox drain sets this. The live attempt carries the same
            # clientEventId (D4 try-first) but is NOT a replay, so the server
            # cannot infer replay-ness from the id.
            payload["replay"] = True
        if dead:
            # Dead-letter drain pass, mutually exclusive with replay.
            # dead_status is the terminal status that got this row
            # dead-lettered locally -- it lands in the server's reviewReason.
            payload["dead"] = True
            if dead_status is not None:
                payload["deadStatus"] = dead_status
        if intent in ("IN", "OUT"):
            payload["intent"] = intent
        if clock_suspect:
            payload["clockSuspect"] = True
        if force_close_confirmed:
            # Offline force-close: the two-scan confirm ran on the kiosk, so there
            # is no server token to echo. The server honors this only on a replay.
            payload["forceCloseConfirmed"] = True
        body = json.dumps(payload)

        headers = self._headers("POST", path, body)
        try:
            r = self.session.post(
                self.base_url + path, headers=headers, data=body, timeout=10
            )
        except Exception as e:
            log.error(f"Failed to post scan: {e}")
            return {"error": str(e)}, 0, None

        retry_after = r.headers.get("Retry-After")
        try:
            return r.json(), r.status_code, retry_after
        except ValueError:
            # Non-JSON body (e.g. the waker's 503 HTML on a cold-wake scan) --
            # warming, not failure. Never lose the scan on a parse error.
            return {"error": "non-JSON response", "type": "warming"}, r.status_code, retry_after

    def get_attendance(self):
        if not self.attendance_path:
            return {"error": "no attendance_path configured"}, 0
        path = self.attendance_path
        headers = self._headers("GET", path)
        try:
            r = self.session.get(
                self.base_url + path, headers=headers, timeout=10
            )
            return r.json(), r.status_code
        except Exception as e:
            log.error(f"Failed to get attendance: {e}")
            return {"error": str(e)}, 0

    def get_server_version(self):
        # Public, DB-free route returning {"version": <git sha>}; it ignores the
        # signature headers below, which are sent anyway for uniformity.
        path = "/api/system-status/kiosk-version"
        headers = self._headers("GET", path)
        try:
            r = self.session.get(
                self.base_url + path, headers=headers, timeout=5
            )
            data = r.json()
            advertised = data.get("scanProtocolVersion")
            protocol = advertised if isinstance(advertised, int) else 1
            return data.get("version"), protocol, r.status_code
        except Exception as e:
            log.error(f"Failed to get server version: {e}")
            return None, 1, 0

# A wall-clock step larger than this vs monotonic is a clockSuspect scan
# (NTP jump, bad RTC). Small skew is don't-care.
CLOCK_STEP_SECONDS = 180

# The scan-body generation this client speaks (2 = replay/dead/intent/
# clockSuspect). Sent with every POST /api/scan; replay behavior is enabled
# only when the server advertises at least this via kiosk-version, so an
# auto-updated kiosk can't race a not-yet-deployed server.
SCAN_PROTOCOL_VERSION = 2


class ClockWatch:
    """Detect a large step in wall time that would stamp scannedAt wrong."""

    def __init__(self):
        self._last_wall = time.time()
        self._last_mono = time.monotonic()

    def check(self):
        wall = time.time()
        mono = time.monotonic()
        jumped = abs((wall - self._last_wall) - (mono - self._last_mono)) > CLOCK_STEP_SECONDS
        self._last_wall = wall
        self._last_mono = mono
        return jumped


class AttendanceState:
    def __init__(self):
        self.lock = threading.Lock()
        self.subscribers = []  # list of queue.Queue for SSE clients
        self.current_counts = {"total": 0, "keyholders": 0, "volunteers": 0, "students": 0}
        self.confirm_token = None    # force-close confirm token, if a countdown is running
        self.confirm_deadline = 0.0  # monotonic clock, end of that countdown
        # Offline force-close: the server mints no token while disconnected, so
        # the kiosk arms its own two-scan confirm, bound to the keyholder who
        # triggered the warning. The confirm scan carries forceCloseConfirmed.
        self.local_close_participant = None
        self.local_close_deadline = 0.0  # monotonic clock, end of that countdown
        self.scan_protocol = 1       # server-advertised scan generation; drain holds below 2
        self.last_browser_seen = time.monotonic()
        self.last_attendance_ok = None
        self.attendance_auth_fail = False
        self.scanner_ok = True
        # Local presence view: the direction the kiosk displays is the intent
        # of record. Seeded from the last attendance fetch; updated on each
        # badge so offline scans still carry IN/OUT.
        self.present_ids = set()
        # Keyholders present and the last known two-deep state, from the roster.
        # Offline these decide whether a keyholder's OUT is a last-out-with-others
        # close, and whether to show a (yellow-only) supervision caution.
        self.keyholder_ids = set()
        # False until the first successful attendance poll: before that the
        # zeroed counts must not read as a closed facility.
        self.attendance_seen = False
        self.last_two_deep_violation = False
        self.clock_watch = ClockWatch()

    def arm_confirm(self, token, seconds):
        """Hold the confirm token the server minted with a force-close warning."""
        with self.lock:
            self.confirm_token = token
            self.confirm_deadline = time.monotonic() + seconds

    def take_confirm(self):
        """Pop the confirm token for the next scan. Single use, and only while
        its countdown is still running — an expired countdown confirms nothing."""
        with self.lock:
            token = self.confirm_token
            live = time.monotonic() < self.confirm_deadline
            self.confirm_token = None
            self.confirm_deadline = 0.0
            return token if live else None

    def arm_local_close(self, participant_id, seconds):
        """Arm the offline force-close confirm for this keyholder. The next scan
        of the SAME badge within the window is the confirm (no server token)."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            return
        with self.lock:
            self.local_close_participant = pid
            self.local_close_deadline = time.monotonic() + seconds

    def take_local_close(self, participant_id):
        """True iff a live offline-close confirm is armed for THIS badge — single
        use. Another badge never consumes it; an expired one is cleared lazily."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            return False
        with self.lock:
            live = time.monotonic() < self.local_close_deadline
            if self.local_close_participant == pid and live:
                self.local_close_participant = None
                self.local_close_deadline = 0.0
                return True
            if not live:
                self.local_close_participant = None
                self.local_close_deadline = 0.0
            return False

    def offline_last_keyholder(self, participant_id):
        """From the last roster: is this badge a keyholder who is the only
        keyholder present, with others still here — the close condition. Stale
        while offline, but the keyholder can see the room."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            return False
        with self.lock:
            return (pid in self.keyholder_ids
                    and self.current_counts.get("keyholders", 0) <= 1
                    and self.current_counts.get("total", 0) > 1)

    def offline_supervision_warning(self):
        """Yellow supervision caution from the last known safety state, or None.
        Never red offline: the kiosk cannot re-check two-deep without the server,
        so it warns and trusts the keyholder standing at the reader."""
        with self.lock:
            return TWO_DEEP_CLOSE_WARNING if self.last_two_deep_violation else None

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

    def displayed_intent(self, participant_id):
        """IN if this badge is not currently shown as present, else OUT."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            pid = participant_id
        with self.lock:
            return "OUT" if pid in self.present_ids else "IN"

    def note_presence(self, participant_id, checking_in, is_keyholder=None):
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            return
        with self.lock:
            if checking_in:
                self.present_ids.add(pid)
            else:
                self.present_ids.discard(pid)

    def seed_from_attendance(self, att_data):
        """Replace the local presence view with the server roster."""
        visits = att_data.get("attendance") or []
        present = set()
        keyholders = set()
        for visit in visits:
            person = visit.get("participant") or visit.get("person") or {}
            pid = person.get("id")
            if pid is None:
                continue
            present.add(int(pid))
            if person.get("isKeyholder"):
                keyholders.add(int(pid))
        safety = att_data.get("safety") or {}
        with self.lock:
            self.present_ids = present
            self.keyholder_ids = keyholders
            self.last_two_deep_violation = bool(safety.get("isTwoDeepViolation"))
            self.attendance_seen = True

    def facility_closed(self):
        """Best-effort local view of whether the facility is closed (no keyholder
        present), from the last successful attendance poll. Never claims closed
        before the first poll — zeroed startup counts are unknown, not closed.
        Offline it can't tell an arriving keyholder from a member (keyholder_ids
        holds only present keyholders); the offline hold copy is hedged for that."""
        with self.lock:
            return self.attendance_seen and self.current_counts.get("keyholders", 0) == 0

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
    /* No fade: an amber banner stays fully legible for its whole dwell, which
       for the force-close warning is its countdown and for a closed-facility
       hold is CLOSED_HOLD_DWELL_S. */
    animation: none;
  }}
  .banner-saved {{
    background: rgba(37,99,235,0.95);
    border: 2px solid #60a5fa;
    color: #fff;
  }}
  #queue-badge {{
    position: absolute;
    bottom: 12px;
    right: 12px;
    z-index: 9998;
    background: rgba(37,99,235,0.9);
    color: #fff;
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: bold;
    display: none;
  }}
  #fc-countdown {{ font-size: 2.5rem; }}
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

  // D5: a live queued-count on the SSE stream so staff watch the backlog drain.
  function updateQueueBadge(n) {{
    const b = document.getElementById("queue-badge");
    if (n > 0) {{
      b.textContent = n + " queued";
      b.style.display = "block";
    }} else {{
      b.style.display = "none";
    }}
  }}

  // Visible force-close countdown. Ticks the <span> the banner carries, then
  // clears the banner — the token expires on the proxy at the same moment.
  let countdownTimer = null;
  let bannerTimer = null;

  function startCountdown(seconds) {{
    clearInterval(countdownTimer);
    const el = document.getElementById("fc-countdown");
    if (!el) return;
    let left = seconds;
    countdownTimer = setInterval(() => {{
      left -= 1;
      if (left <= 0) {{
        clearInterval(countdownTimer);
        document.getElementById("flash-container").innerHTML = '';
        return;
      }}
      el.textContent = left;
    }}, 1000);
  }}

  function connectSSE() {{
    const source = new EventSource("/events");

    source.addEventListener("status", function(e) {{
      const data = JSON.parse(e.data);
      handleData(data, true);
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
      if (typeof data.queued === "number") updateQueueBadge(data.queued);
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
        const secs = data.countdown || 0;
        const dwell = data.dwell || 0;
        clearInterval(countdownTimer);
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => {{ container.innerHTML = ''; }}, (dwell || secs || 12) * 1000);
        if (secs) startCountdown(secs);
      }}
      // Tell iframe to refresh attendance display with inline data
      const iframe = document.querySelector("iframe");
      if (iframe && iframe.contentWindow) {{
        if (data.attendance) {{
          iframe.contentWindow.postMessage({{type: "refresh-attendance", attendance: data.attendance, held: data.held, counts: data.counts, safety: data.safety}}, "*");
        }} else {{
          iframe.contentWindow.postMessage("refresh-attendance", "*");
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
  <div id="queue-badge"></div>
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

            while True:
                try:
                    # Wait up to 30s for an event, then send a keepalive comment
                    event_data = q.get(timeout=30)
                    payload = json.dumps(event_data)
                    self.wfile.write(f"event: scan\ndata: {payload}\n\n".encode())
                    self.wfile.flush()
                except queue_mod.Empty:
                    # Timeout — send keepalive to detect dead connections
                    try:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break
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
            except:
                pass

    def log_message(self, format, *args):
        pass

# ---------------------------------------------------------------------------
# USB scanner listener
# ---------------------------------------------------------------------------
def usb_scanner_listener(backend, state, outbox, device_path):
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
                        handle_scan(backend, state, outbox, participant_id)
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

def stdin_scanner_listener(backend, state, outbox):
    log.info("USB device not configured — reading scans from stdin")
    while True:
        try:
            line = input()
            participant_id = line.strip()
            if participant_id:
                log.info(f"Stdin scan: {participant_id}")
                handle_scan(backend, state, outbox, participant_id)
        except EOFError:
            break

# A closed-facility hold dwells far longer than an ordinary banner so the
# member can read why their scan is waiting on someone else. Any later badge
# event replaces it early.
CLOSED_HOLD_DWELL_S = 30
CLOSED_HOLD_COPY = "Scan successful, waiting for key holder before opening the building"
# Offline hold copy. The kiosk can't tell whether the scanner is a keyholder
# (keyholder_ids holds only PRESENT keyholders), so — unlike the server-gated
# CLOSED_HOLD_COPY — this must read true for a keyholder arriving to open too:
# no "waiting for key holder" claim, just a hedged not-yet-checked-in.
OFFLINE_HOLD_COPY = "Scan saved — you'll be checked in once the building is open"

# Offline force-close: the kiosk runs the last-keyholder warning + two-scan
# confirm itself when the server is unreachable. Same window as the server's.
FORCE_CLOSE_CONFIRM_SECONDS = 15
OFFLINE_CLOSE_WARN_COPY = "You are the last key holder and others are still here. Badge again to close the building."
# Yellow, never red: offline the kiosk can't re-verify two-deep, so it warns
# and trusts the keyholder to clear the room (attendance-checkin.md).
TWO_DEEP_CLOSE_WARNING = "Two-deep supervision may not be met -- make sure everyone is out before you close."


def _offline_close_warning_html(supervision=None):
    """Local last-keyholder warning shown when offline: no server token, so the
    countdown just paces the confirm the kiosk is arming itself."""
    parts = [html.escape(OFFLINE_CLOSE_WARN_COPY)]
    if supervision:
        parts.append("⚠️ " + html.escape(supervision))
    parts.append(f'<span id="fc-countdown">{FORCE_CLOSE_CONFIRM_SECONDS}</span>s to confirm')
    return '<div class="banner banner-warning">⚠️ ' + "<br>".join(parts) + '</div>'


def _offline_close_saved_html(queued):
    """The confirm scan, queued while offline: the building is closed locally and
    the close syncs when the link returns."""
    return f'<div class="banner banner-saved">✓ BUILDING CLOSED — will sync ({queued} waiting)</div>'

def _scan_result_banner_html(body, status):
    """Returns (html, countdown_seconds, dwell_seconds). Pure -- arming the
    confirm token is the caller's job, so the drain can render a response
    without arming one. dwell_seconds of 0 means the default dwell."""
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
            countdown = 0
            if body.get("forceCloseToken"):
                seconds = body.get("confirmSeconds")
                countdown = seconds if isinstance(seconds, int) and 0 < seconds <= 120 else 15
                warn += f'<br><span id="fc-countdown">{countdown}</span>s left to confirm'
            return f'<div class="banner banner-warning">⚠️ {warn}</div>', countdown, 0
        err = html.escape(body.get("error", "Unknown error"))
        return f'<div class="banner banner-error">✗ Scan failed: {err}</div>', 0, 0

    stype = body.get("type", "")
    # A park created no Visit, so none of these may render as a check-in: the
    # green tick plus the "?" a park body has no name for reads as one at arm's
    # length. Amber says captured-but-not-complete, which is what happened --
    # the scan is held and projects on its own once a keyholder badges in.
    if stype == "parked":
        if body.get("reason") == "facility_closed":
            return (
                f'<div class="banner banner-warning">✓ {CLOSED_HOLD_COPY}</div>',
                0,
                CLOSED_HOLD_DWELL_S,
            )
        held = html.escape(body.get("message", "Recorded for review."))
        return f'<div class="banner banner-warning">✓ {held}</div>', 0, 0
    # The name the person goes by, resolved server-side by the same rule the kiosk
    # roster uses — nickname, else first name, else the part of the address before
    # the @. The raw address is never sent and never shown.
    who = html.escape(str(body.get("participant", {}).get("name") or "?"))
    msg = html.escape(body.get("message", ""))
    label = "CHECKED IN" if stype == "checkin" else "CHECKED OUT"
    warning = html.escape(body.get("warning", "")).replace("\n", "<br>")
    if warning:
        # Scan succeeded but the room is short of supervising adults (#1436):
        # amber, and it dwells 12s instead of 5s. Still confirms the scan.
        return f'<div class="banner banner-warning">✓ {who} — {label}<br>⚠️ {warning}</div>', 0, 0
    if msg and msg != "Checked in successfully" and msg != "Checked out successfully":
        return f'<div class="banner banner-ok">✓ {who} — {msg}</div>', 0, 0
    return f'<div class="banner banner-ok">✓ {who} — {label}</div>', 0, 0

def _saved_banner_html(queued, intent=None, facility_closed=False):
    # A queued scan reads as done and safe to walk away from -- distinct
    # from the red "not saved" state. The displayed direction is the intent
    # of record even when the server has not acked yet.
    # Returns (html, dwell_seconds); dwell 0 means the default dwell.
    if facility_closed and intent == "IN":
        # No keyholder present per the last poll, so an offline IN is held, not an
        # open — amber and hedged rather than a confident check-in. Hedged copy,
        # not CLOSED_HOLD_COPY: this also fires for a keyholder arriving to open,
        # whom the client can't distinguish offline.
        return (
            f'<div class="banner banner-warning">✓ {OFFLINE_HOLD_COPY} (will sync, {queued} waiting)</div>',
            CLOSED_HOLD_DWELL_S,
        )
    label = "CHECKED IN" if intent == "IN" else "CHECKED OUT" if intent == "OUT" else "Saved"
    return f'<div class="banner banner-saved">✓ {label} — will sync ({queued} waiting)</div>', 0

def handle_scan(backend, state, outbox, participant_id):
    client_event_id = new_event_id()
    scanned_at = now_iso()
    clock_suspect = state.clock_watch.check()
    if clock_suspect:
        outbox.mark_clock_suspect()
        log.warning("Large clock step detected; marking queued scans clockSuspect")
    # A force-close confirm repeats the OUT that warned -- it must NOT toggle to
    # IN off the optimistic presence flip the warning scan already applied. The
    # signal is a live armed confirm: the server's minted token (online) or the
    # kiosk's own armed close (offline, no server token). Take both before
    # deciding intent. Each is single-use and stored with the event if queued --
    # a confirm given before the outage must still close when it drains, rather
    # than parking for review.
    local_close = state.take_local_close(participant_id)
    confirm_token = state.take_confirm()
    force_close_confirmed = local_close
    if confirm_token or local_close:
        intent = "OUT"
    else:
        # Displayed direction, from the local presence view, carried with the
        # event. The server must not re-infer it from live state.
        intent = state.displayed_intent(participant_id)
    state.note_presence(participant_id, checking_in=(intent == "IN"))

    # A fresh scan must not jump its own predecessor -- if this participant
    # already has a pending queued event, enqueue behind it instead of
    # attempting live delivery out of order.
    if outbox.has_pending_for_participant(participant_id):
        outbox.enqueue(
            client_event_id, participant_id, scanned_at, confirm_token,
            intent=intent, clock_suspect=clock_suspect,
            force_close_confirmed=force_close_confirmed,
        )
        queued = outbox.pending_count()
        # The offline force-close confirm normally lands here: its own warning
        # scan is still pending ahead of it. Queue the close behind it and say so.
        if force_close_confirmed:
            state.push_event({"html": _offline_close_saved_html(queued), "queued": queued})
        else:
            banner_html, dwell = _saved_banner_html(queued, intent, facility_closed=state.facility_closed())
            state.push_event({"html": banner_html, "queued": queued, "dwell": dwell})
        log.info(f"Queued (predecessor pending): participant {participant_id} {intent}")
        return

    body, status, retry_after = backend.post_scan(
        participant_id,
        force_close_token=confirm_token,
        client_event_id=client_event_id,
        scanned_at=scanned_at,
        intent=intent,
        clock_suspect=clock_suspect,
        force_close_confirmed=force_close_confirmed,
    )
    outcome = classify_response(status, body)

    if outcome == "retry":
        # Try live first; only persist to the outbox if it wasn't confirmed.
        outbox.enqueue(
            client_event_id, participant_id, scanned_at, confirm_token,
            intent=intent, clock_suspect=clock_suspect,
            force_close_confirmed=force_close_confirmed,
        )
        queued = outbox.pending_count()
        if not force_close_confirmed and intent == "OUT" and state.offline_last_keyholder(participant_id):
            # Offline last-keyholder close: no server to warn or mint a token, so
            # the kiosk runs the warning + two-scan confirm itself. This OUT touch
            # is already queued above (it parks harmlessly on drain -- the badge is
            # never lost); the confirm scan queues the actual close.
            state.arm_local_close(participant_id, FORCE_CLOSE_CONFIRM_SECONDS)
            supervision = state.offline_supervision_warning()
            state.push_event({"html": _offline_close_warning_html(supervision),
                              "countdown": FORCE_CLOSE_CONFIRM_SECONDS})
            log.warning(f"Offline force-close warning: last keyholder {participant_id}, others present")
        elif force_close_confirmed:
            state.push_event({"html": _offline_close_saved_html(queued), "queued": queued})
            log.warning(f"Offline force-close CONFIRMED, queued: keyholder {participant_id}")
        else:
            banner_html, dwell = _saved_banner_html(queued, intent, facility_closed=state.facility_closed())
            state.push_event({"html": banner_html, "queued": queued, "dwell": dwell})
            log.warning(f"Scan queued (server unreachable/warming): participant {participant_id} {intent}")
        return

    # ack or dead: server responded definitively at scan time -- render the
    # existing immediate banner, unchanged behavior for the online path.
    banner_html, countdown, dwell = _scan_result_banner_html(body, status)
    if countdown:
        state.arm_confirm(body["forceCloseToken"], countdown)
    state.push_event({"html": banner_html, "countdown": countdown, "dwell": dwell})

    if outcome == "ack":
        ptype = body.get("type", "?")
        who = body.get("participant", {}).get("name") or "?"
        log.info(f"Scan result: {ptype.upper()} — {who}")
    else:
        log.warning(f"Scan rejected, not queued: {body.get('error', body)}")

    # Fetch fresh attendance and push update for the iframe
    if backend.attendance_path and outcome == "ack":
        att_data, att_status = backend.get_attendance()
        if att_status == 200:
            state.seed_from_attendance(att_data)
            event_payload = {"html": ""}
            for key in ("attendance", "held", "counts", "safety"):
                if key in att_data:
                    event_payload[key] = att_data[key]
            if "counts" in att_data:
                with state.lock:
                    state.current_counts = att_data["counts"]
            state.push_event(event_payload)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def attendance_poller(backend, state, interval=30, sleep_fn=time.sleep,
                       in_closed_window_fn=in_closed_window):
    """Background thread that polls attendance counts periodically.
    Pushes SSE status events when counts change so the blackout
    logic works on display-only kiosks without a scanner. §3.1/Q17: a
    24/7 kiosk must not defeat the overnight curfew with signed GETs."""
    while True:
        sleep_fn(interval)
        if in_closed_window_fn():
            continue
        att_data, att_status = backend.get_attendance()
        if att_status == 200 and "counts" in att_data:
            state.seed_from_attendance(att_data)
            new_counts = att_data["counts"]
            with state.lock:
                changed = new_counts != state.current_counts
                state.current_counts = new_counts
            if changed:
                log.info(f"Attendance poll: {new_counts.get('total', '?')} present")
                state.push_event({"html": "", "counts": new_counts})

def _read_last_restart_target(path=SELF_UPDATE_STATE_FILE):
    # Missing/unreadable file means "never restarted" -- same as no target.
    try:
        with open(path) as f:
            return f.read().strip() or None
    except OSError:
        return None

def _write_last_restart_target(remote_head, path=SELF_UPDATE_STATE_FILE):
    # True only once the sha reads back off disk; the caller must not exit
    # on False or the next boot forgets this attempt and loops (#1616).
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
    version_poller restarts when HEAD differs, so both read it from here and
    cannot disagree about where the Pi is meant to be."""
    tag = latest_release_tag()
    if tag and _tracks_releases(tag):
        return subprocess.check_output(
            ["git", "rev-list", "-n", "1", tag], text=True
        ).strip()
    return subprocess.check_output(
        ["git", "rev-parse", "origin/main"], text=True
    ).strip()

def version_poller(backend, state, interval=60, state_path=SELF_UPDATE_STATE_FILE,
                    in_closed_window_fn=in_closed_window):
    """Background thread that checks for client and server version updates."""
    last_restart_target = _read_last_restart_target(state_path)

    # Get initial server version
    initial_server_version = None
    for _ in range(6):
        sv, sp, status = backend.get_server_version()
        if status == 200 and sv:
            initial_server_version = sv
            state.scan_protocol = sp
            log.info(f"Initial server version: {initial_server_version} (scan protocol {sp})")
            break
        time.sleep(5)

    while True:
        time.sleep(interval)

        # 1. Check Server Version Update -- skipped during the closed window
        # (§3.1): this signed GET keep-alives the service same as
        # attendance_poller's. Self-update below is NOT gated: the git fetch
        # hits no server, and overnight is the safe window to restart in.
        # NOT gated on the init fetch having succeeded: the drain's protocol
        # gate feeds off this poll, and a kiosk that boots while the backend
        # is down (the exact condition that fills the outbox) must still
        # learn the protocol once the server is back.
        if not in_closed_window_fn():
            sv, sp, status = backend.get_server_version()
            if status == 200:
                state.scan_protocol = sp
            if status == 200 and sv and initial_server_version is None:
                initial_server_version = sv
                log.info(f"Server version (late init): {sv} (scan protocol {sp})")
            elif status == 200 and sv and sv != initial_server_version:
                log.info(f"Server version changed from {initial_server_version} to {sv}. Requesting reload.")
                state.push_event({"reload": True})
                initial_server_version = sv  # Update to prevent spam

        # 2. Check Client Version Update
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

    log.info(f"Backend: {backend_url}")
    log.info(f"Key:     {key_path}")
    log.info(f"USB:     {usb_device or '(stdin fallback)'}")
    log.info(f"Port:    {port}")
    log.info(f"Path:    {kiosk_path}")
    log.info(f"Attendance: {attendance_path or '(disabled)'}")

    if not os.path.exists(key_path):
        log.error(f"Private key not found: {key_path}")
        sys.exit(1)
    signing_key = load_signing_key(key_path)

    backend = BackendClient(backend_url, signing_key, attendance_path or None)
    state = AttendanceState()
    outbox = Outbox(config.get("outbox_path", DEFAULT_OUTBOX_PATH))
    log.info(f"Outbox:  {outbox.path} ({outbox.pending_count()} pending on start)")

    # Fetch initial attendance state (only if attendance_path is configured)
    if attendance_path:
        log.info("Fetching initial attendance state...")
        att_data, att_status = backend.get_attendance()
        if att_status == 200 and "counts" in att_data:
            state.current_counts = att_data["counts"]
            state.seed_from_attendance(att_data)
            log.info(f"Initial state: {state.current_counts['total']} people present")
        else:
            log.warning("Could not fetch initial attendance state")

        # Start background poller for blackout updates
        poller = threading.Thread(target=attendance_poller, args=(backend, state), daemon=True)
        poller.start()

    # Start version poller thread
    vpoller = threading.Thread(target=version_poller, args=(backend, state), daemon=True)
    vpoller.start()

    allow_reboot = bool(config.get("allow_reboot", False))
    allow_wifi_bounce = bool(config.get("allow_wifi_bounce", False))
    hmon = threading.Thread(
        target=health_monitor,
        args=(backend_url, state),
        kwargs={"allow_reboot": allow_reboot, "allow_wifi_bounce": allow_wifi_bounce},
        daemon=True,
    )
    hmon.start()

    # Start the outbox replay thread: drains queued scans in order,
    # re-signing and resubmitting each one, once the backend is reachable.
    drain = threading.Thread(
        target=replay_drain, args=(outbox, backend.post_scan, state.push_event),
        kwargs={"protocol_ok_fn": lambda: state.scan_protocol >= SCAN_PROTOCOL_VERSION}, daemon=True
    )
    drain.start()

    if usb_device:
        scanner = threading.Thread(target=usb_scanner_listener, args=(backend, state, outbox, usb_device), daemon=True)
    else:
        scanner = threading.Thread(target=stdin_scanner_listener, args=(backend, state, outbox), daemon=True)
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
