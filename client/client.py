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
import email.utils
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

# The board's own roster GETs, proxied through this Pi.
ROSTER_GET_PATHS = ("/api/attendance", "/api/kioskdisplay/certifications")


CLOCK_INTERVAL_S = 30


def local_clock_label(now=None):
    """The Pi's local time and zone as this process sees them, flagged when
    in_closed_window considers it overnight."""
    now = now or datetime.now().astimezone()
    label = now.strftime("%H:%M %Z (UTC%z)")
    if in_closed_window(now):
        label += " · overnight"
    return label


def roster_get_key(path):
    """The ROSTER_GET_PATHS entry a proxied path (query already stripped) is,
    or None."""
    return path if path in ROSTER_GET_PATHS else None


def is_page_load(path):
    """A board HTML navigation (not an API call or a static asset)."""
    if path.startswith(("/api/", "/_next/")):
        return False
    return "." not in path.rsplit("/", 1)[-1]


def building_known_empty(state):
    """True only when the last real roster fetch reported nobody inside and no
    badge on this Pi has put anyone inside since."""
    with state.lock:
        return (state.counts_known and state.current_counts.get("total", 0) == 0
                and not state.present_ids)


def skip_roster_get(state, method, path):
    """True when the proxy answers the board's roster GET itself, with a 204
    and no body: the building is known empty (with one door, every arrival
    badges here first) and this board path has already been served the real
    roster since the last fetch. The board keeps that real roster."""
    key = roster_get_key(path)
    if state is None or method != "GET" or key is None:
        return False
    with state.lock:
        served = state.served_generation.get(key) == state.roster_generation
    return served and building_known_empty(state)


def kiosk_quiet(state, outbox):
    """Known empty with nothing queued: the kiosk sends the server nothing on
    its own, so prod's overnight curfew can fire and the database can pause."""
    return building_known_empty(state) and outbox.pending_count() == 0


# The kiosk's own view before any server roster: no `safety`, which the page
# reads as unknown rather than as a compliant room.
NO_ROSTER = {
    "access": "full",
    "counts": {"total": 0, "keyholders": 0, "volunteers": 0, "youth": 0},
    "attendance": [],
}

# Roster label for a badge the kiosk has never seen on a server roster.
UNKNOWN_PERSON_NAME = "Checked in offline"

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
                  intent=None, clock_suspect=False,
                  force_close_confirmed=False, close=None, roster_as_of=None, shown_empty=None):
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
        if intent in ("IN", "OUT"):
            payload["intent"] = intent
        if clock_suspect:
            payload["clockSuspect"] = True
        if force_close_confirmed:
            # A close confirmed by an older client, still in the outbox.
            payload["forceCloseConfirmed"] = True
        if shown_empty is not None:
            # An older client's close signal on a row it queued: true is a
            # one-badge close, false a leave.
            payload["shownEmpty"] = bool(shown_empty)
        if close:
            # The keyholder's close decision: "alone" or "confirmed".
            payload["close"] = close
            if roster_as_of:
                payload["rosterAsOf"] = roster_as_of
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
            data = r.json()
            if r.status_code == 200 and isinstance(data, dict):
                # When the server built this roster, by its own clock: a close
                # sends it so the server can tell check-ins this roster missed.
                data["rosterAsOf"] = _server_date(r.headers.get("Date"))
            return data, r.status_code
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

def _server_date(header):
    """The HTTP Date header as an ISO timestamp, or None when absent or unreadable."""
    try:
        return email.utils.parsedate_to_datetime(header).isoformat() if header else None
    except (TypeError, ValueError):
        return None


# A wall-clock step larger than this vs monotonic is a clockSuspect scan
# (NTP jump, bad RTC). Small skew is don't-care.
CLOCK_STEP_SECONDS = 180

# The scan-body generation this client speaks (2 = replay/intent/
# clockSuspect; 3 = the kiosk filters repeat reads itself; 5 = shownEmpty;
# 6 = close; 7 = the server parks a replay it cannot apply, so the drain only
# acks or retries). Sent
# with every POST /api/scan. Below this on the server, nothing is sent live and
# the drain holds, so an auto-updated kiosk can't race a not-yet-deployed
# server into ignoring a close.
SCAN_PROTOCOL_VERSION = 7


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
        # False until a real roster fetch: "unknown" never counts as empty.
        self.counts_known = False
        # Bumped on every real roster fetch. A board roster path is served the
        # server's answer at least once per generation before the proxy rests it.
        self.roster_generation = 0
        self.served_generation = {}
        # Bumped by every local presence change (a badge, a check-in on the
        # board). A roster fetch that straddles one is not seeded.
        self.presence_seq = 0
        # The close prompt: a keyholder left while others were shown inside, and
        # a second scan of the same badge before the deadline closes the
        # building. Online and offline alike; the server keeps no prompt state.
        self.local_close_participant = None
        self.local_close_deadline = 0.0  # monotonic clock, end of that countdown
        self.local_close_banner = None   # (html, seconds) re-shown when that window slides
        self.last_read = {}          # participant id -> monotonic time of its last read
        self.scan_protocol = 1       # server-advertised scan generation; drain holds below ours
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
        # Every keyholder any roster has shown since start: a keyholder whose
        # check-in is still queued is not on the roster but may still close.
        self.known_keyholders = set()
        # Server time of the last roster fetched; None until one arrives.
        self.roster_as_of = None
        self.last_two_deep_violation = False
        self.clock_watch = ClockWatch()
        # The last server roster, the base of the kiosk's own offline view.
        self.last_roster_body = None
        # Every roster participant seen, and when this kiosk saw each badge IN:
        # what it needs to draw someone the last roster does not show yet.
        self.known_people = {}
        self.local_arrivals = {}
        # When the kiosk last received a server roster (ISO), or None.
        self.roster_at = None

    def arm_local_close(self, participant_id, seconds, banner_html=None):
        """Arm the close prompt for this keyholder. The next scan of the SAME
        badge within the window closes the building."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            return
        with self.lock:
            self.local_close_participant = pid
            self.local_close_deadline = time.monotonic() + seconds
            self.local_close_banner = (banner_html, seconds)

    def slide_close(self, participant_id):
        """A held badge's repeat read: restart its live close window from this
        read. Returns the banner event that restarts the on-screen countdown, or
        None when no close is armed for this badge."""
        pid = int(participant_id)
        now = time.monotonic()
        with self.lock:
            if now >= self.local_close_deadline:
                self.local_close_banner = None
            banner = self.local_close_banner
            if self.local_close_participant != pid or banner is None:
                return None
            self.local_close_deadline = now + banner[1]
            if not banner[0]:
                return None
            return {"html": banner[0], "countdown": banner[1]}

    def take_local_close(self, participant_id):
        """True iff the close prompt is live for THIS badge. Any scan ends the
        prompt: another badge means the keyholder just left, and that badge is
        then handled as an ordinary scan."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            pid = None
        with self.lock:
            live = time.monotonic() < self.local_close_deadline
            mine = live and pid is not None and self.local_close_participant == pid
            self.local_close_participant = None
            self.local_close_deadline = 0.0
            self.local_close_banner = None
            return mine

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

    def close_decision(self, participant_id):
        """For a badge leaving, from what the kiosk shows (roster plus queued
        scans): ("alone", []) for a keyholder shown with nobody else inside,
        ("prompt", others) for a keyholder shown with others, else (None, [])."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            return None, []
        with self.lock:
            if pid not in self.known_keyholders:
                return None, []
            others = sorted(self.present_ids - {pid})
            return ("prompt", others) if others else ("alone", [])

    def forget_keyholder(self, participant_id):
        """This badge is not a keyholder (any more): it is offered no close."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            return
        with self.lock:
            self.known_keyholders.discard(pid)
            self.keyholder_ids.discard(pid)

    def clear_present(self):
        """A close empties the kiosk's view of the building."""
        with self.lock:
            self.present_ids = set()

    def others_shown(self, participant_id):
        """Roster names of everyone but this badge the kiosk shows inside."""
        try:
            pid = int(participant_id)
        except (TypeError, ValueError):
            pid = None
        with self.lock:
            return sorted(
                (self.known_people.get(other) or {}).get("name") or UNKNOWN_PERSON_NAME
                for other in self.present_ids - {pid}
            )

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
            self.presence_seq += 1
            if checking_in:
                self.present_ids.add(pid)
                self.local_arrivals[pid] = now_iso()
            else:
                self.present_ids.discard(pid)

    def seed_from_attendance(self, att_data, pending=(), since_seq=None):
        """Replace the local presence view with the server roster, plus this
        kiosk's undelivered outbox rows, which the roster does not show yet. Snapshot `pending` BEFORE the fetch: a
        row that drains in between is then in both (harmless); taken after, it
        could be in neither. Keyholder ids stay roster-only.

        `since_seq` is presence_seq read with that snapshot. If a badge or a
        board check-in landed during the fetch, the roster may predate it:
        nothing is seeded and this returns False."""
        visits = att_data.get("attendance") or []
        present = set()
        keyholders = set()
        present_non_keyholders = set()
        for visit in visits:
            person = visit.get("participant") or visit.get("person") or {}
            pid = person.get("id")
            if pid is None:
                continue
            present.add(int(pid))
            if person.get("isKeyholder"):
                keyholders.add(int(pid))
            elif "isKeyholder" in person:
                present_non_keyholders.add(int(pid))
        arrivals = {}
        _overlay_pending(present, pending, arrivals)
        safety = att_data.get("safety") or {}
        with self.lock:
            if since_seq is not None and since_seq != self.presence_seq:
                return False
            self.known_people.update(
                (int(p["id"]), p) for p in (v.get("participant") for v in visits)
                if p and p.get("id") is not None)
            self.local_arrivals.update(arrivals)
            self.present_ids = present
            self.keyholder_ids = keyholders
            self.known_keyholders |= keyholders
            self.known_keyholders -= present_non_keyholders
            if att_data.get("rosterAsOf"):
                self.roster_as_of = att_data["rosterAsOf"]
            self.last_two_deep_violation = bool(safety.get("isTwoDeepViolation"))
            self.counts_known = True
            self.roster_generation += 1
            self.last_roster_body = json.dumps(att_data)
            self.roster_at = now_iso()
        return True

    def roster_snapshot(self, outbox):
        """(pending rows, presence_seq), read together before a roster fetch."""
        with self.lock:
            seq = self.presence_seq
        return outbox.pending_rows(), seq

    def apply_pending(self, pending):
        """Overlay undelivered outbox rows when there is no roster to seed from."""
        with self.lock:
            _overlay_pending(self.present_ids, pending, self.local_arrivals)

    def attendance_view(self):
        """The roster the kiosk shows: the last server roster with this kiosk's
        presence view (its queued and live scans) applied. Unchanged membership
        replays the roster as is; changed membership recounts and drops
        `safety`, which the kiosk cannot recompute (the page reads that as
        unknown). `kioskAsOf` (when the roster arrived, None if never) marks
        every such body as not fresh from the server."""
        with self.lock:
            last = self.last_roster_body
            roster_at = self.roster_at
            present = set(self.present_ids)
            people = dict(self.known_people)
            arrivals = dict(self.local_arrivals)
        view = json.loads(last) if last else json.loads(json.dumps(NO_ROSTER))
        roster = view.get("attendance") or []
        shown = [v for v in roster if _visit_pid(v) in present]
        missing = present - {_visit_pid(v) for v in shown}
        if missing or len(shown) != len(roster):
            for pid in sorted(missing):
                shown.append({
                    "id": -pid,
                    "arrivedAt": arrivals.get(pid) or now_iso(),
                    "participant": people.get(pid) or {
                        "id": pid, "name": UNKNOWN_PERSON_NAME, "email": "", "isKeyholder": False},
                })
            view["attendance"] = shown
            view["counts"] = _roster_counts(shown, view.get("counts"))
            view.pop("safety", None)
        view["kioskAsOf"] = roster_at
        return view


def _visit_pid(visit):
    person = visit.get("participant") or visit.get("person") or {}
    try:
        return int(person.get("id"))
    except (TypeError, ValueError):
        return None


def _roster_counts(visits, prior):
    """Counts as the page columns them; an unknown youth flag counts as youth."""
    people = [v.get("participant") or {} for v in visits]
    youth = [p.get("isYouth", True) is not False for p in people]
    counts = {
        "total": len(people),
        "keyholders": sum(1 for p in people if p.get("isKeyholder")),
        "volunteers": sum(1 for p, y in zip(people, youth) if not p.get("isKeyholder") and not y),
        "youth": sum(youth),
    }
    if prior and "needReview" in prior:
        counts["needReview"] = prior["needReview"]
    return counts


def _overlay_pending(present, pending, arrivals=None):
    """Apply undelivered scans (outbox.pending_rows(), scanned_at ASC) to a
    presence set: the last intent per person wins. `arrivals` collects each
    queued IN's scan time."""
    for row in pending:
        if len(row) > 8 and row[8]:
            # A queued close: everyone shown before it has left.
            present.clear()
            continue
        try:
            pid = int(row[1])
        except (TypeError, ValueError):
            continue
        if row[5] == "IN":
            present.add(pid)
            if arrivals is not None:
                arrivals[pid] = row[2]
        elif row[5] == "OUT":
            present.discard(pid)

# ---------------------------------------------------------------------------
# Transparent Signing Proxy & Kiosk Handler
# ---------------------------------------------------------------------------
class KioskHandler(BaseHTTPRequestHandler):
    state = None
    backend = None
    outbox = None
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
       for the force-close warning is its countdown. */
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

    // The Pi's local time as Python sees it: the clock in_closed_window uses.
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
        clearInterval(countdownTimer);
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => {{ container.innerHTML = ''; }}, (secs || 12) * 1000);
        if (secs) startCountdown(secs);
      }}
      // Tell iframe to refresh attendance display with inline data
      const iframe = document.querySelector("iframe");
      if (iframe && iframe.contentWindow) {{
        if (data.attendance) {{
          iframe.contentWindow.postMessage({{type: "refresh-attendance", attendance: data.attendance, counts: data.counts, safety: data.safety}}, "*");
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

        if method == "GET" and is_page_load(sign_path) and self.state is not None:
            # A reloaded board starts with nothing on screen: its roster GETs
            # get the server's answer once more before the proxy rests them.
            with self.state.lock:
                self.state.served_generation.clear()

        body_str = ""
        if body_bytes:
            try:
                body_str = body_bytes.decode('utf-8')
            except UnicodeDecodeError:
                pass
                
        sig_headers = sign_request(self.backend.signing_key, method, sign_path, body_str)
        req_headers.update(sig_headers)

        if skip_roster_get(self.state, method, sign_path):
            # Chromium is still up; don't let last_browser_seen look like a crash.
            self.state.last_browser_seen = time.monotonic()
            try:
                self.send_response(204)
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        # The kiosk shows its own view rather than an error when the server
        # cannot answer the roster GET.
        own_view = self.state is not None and method == "GET" and sign_path == "/api/attendance"
        # Snapshot before the fetch, as seed_from_attendance requires.
        pending, seq = ((), None)
        if own_view and self.outbox is not None:
            pending, seq = self.state.roster_snapshot(self.outbox)
        generation_at_send = self.state.roster_generation if self.state is not None else 0
        relayed = False

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
            if own_view and resp.status_code >= 500:
                # Unreachable, warming (503) or a gateway error.
                resp.close()
                self._send_json(json.dumps(self.state.attendance_view()))
                return

            relayed = True
            try:
                self.send_response(resp.status_code)
                for k, v in resp.headers.items():
                    if k.lower() not in ['transfer-encoding', 'connection', 'content-encoding']:
                        self.send_header(k, v)
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError):
                return

            key = roster_get_key(sign_path)
            remember = (self.state is not None and method == "GET"
                        and resp.status_code == 200 and key is not None)
            chunks = []
            try:
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        self.wfile.write(chunk)
                        if remember:
                            chunks.append(chunk)
            except (BrokenPipeError, ConnectionResetError):
                # Browser closed the connection, normal for HMR or page reloads
                remember = False
            if remember:
                self._note_roster_served(key, b"".join(chunks), pending, seq, generation_at_send,
                                         _server_date(resp.headers.get("Date")))
            elif (self.state is not None and method != "GET"
                    and sign_path.startswith("/api/attendance") and 200 <= resp.status_code < 300):
                # A check-in/out made on the board itself: occupancy is unknown
                # until the next real fetch, and a fetch already in flight must
                # not seed over it.
                with self.state.lock:
                    self.state.counts_known = False
                    self.state.presence_seq += 1

        except Exception as e:
            if not isinstance(e, (BrokenPipeError, ConnectionResetError)):
                log.error(f"Proxy error for {self.path}: {e}")
            if own_view and not relayed:
                self._send_json(json.dumps(self.state.attendance_view()))
                return
            try:
                # If we haven't sent headers yet, try to send a 502
                self.send_response(502)
                self.end_headers()
            except:
                pass

    def _note_roster_served(self, key, body, pending, seq, generation_at_send, roster_as_of=None):
        """Record that this board path was given the server's roster. A full
        attendance roster is the newest the kiosk has, so it is seeded and
        credited to the generation it creates; anything else is credited to the
        generation current when it was sent, so an answer that predates a newer
        fetch never rests the board."""
        roster = _full_roster(body.decode("utf-8", "replace")) if key == "/api/attendance" else None
        if roster is not None:
            roster["rosterAsOf"] = roster_as_of
        if roster is not None and self.state.seed_from_attendance(roster, pending, since_seq=seq):
            with self.state.lock:
                if "counts" in roster:
                    self.state.current_counts = roster["counts"]
                self.state.served_generation[key] = self.state.roster_generation
            return
        with self.state.lock:
            if self.state.served_generation.get(key, -1) < generation_at_send:
                self.state.served_generation[key] = generation_at_send

    def _send_json(self, text):
        body = text.encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format, *args):
        pass


def _full_roster(text):
    """The parsed body when it is a full-access roster, else None."""
    try:
        body = json.loads(text)
    except ValueError:
        return None
    if isinstance(body, dict) and body.get("access") == "full" and isinstance(body.get("attendance"), list):
        return body
    return None

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

# The close prompt's window: a keyholder who leaves while others are shown has
# this long to scan the same badge again and close the building.
FORCE_CLOSE_CONFIRM_SECONDS = 15
# Reads of one badge this close together are one scan (a scanner double-read).
# A close confirm is therefore a second badge after this, inside the countdown.
REPEAT_READ_SECONDS = 3.0
CLOSING_ALONE_COPY = "You are closing the building. The building should be empty."
# Yellow, never red: the kiosk can't re-verify two-deep itself, so it warns
# and trusts the keyholder to clear the room (attendance-checkin.md).
TWO_DEEP_CLOSE_WARNING = "Two-deep supervision may not be met -- make sure everyone is out before you close."


def _close_prompt_html(who, others, supervision=None):
    """A keyholder left while others are shown inside: list them and offer the
    close. Names are server-supplied labels, so every one is escaped."""
    parts = [f"✓ {html.escape(who)} — CHECKED OUT",
             "Still inside: " + html.escape(", ".join(others)),
             "Scan again to close the building."]
    if supervision:
        parts.append("⚠️ " + html.escape(supervision))
    parts.append(f'<span id="fc-countdown">{FORCE_CLOSE_CONFIRM_SECONDS}</span>s to confirm')
    return '<div class="banner banner-warning">' + "<br>".join(parts) + '</div>'


def _held_close_html(who, prompt):
    """The server held a one-badge close: it knows of a check-in this kiosk's
    roster missed. Its prompt names them; every value is escaped."""
    return ('<div class="banner banner-warning">'
            f"✓ {html.escape(who)} — CHECKED OUT<br>⚠️ {html.escape(prompt)}"
            f'<br><span id="fc-countdown">{FORCE_CLOSE_CONFIRM_SECONDS}</span>s to confirm</div>')


def _closed_html(kind, queued=None):
    """The building is closed on the kiosk's say-so; `queued` when it syncs later."""
    text = CLOSING_ALONE_COPY if kind == "alone" else "BUILDING CLOSED"
    sync = f" — will sync ({queued} waiting)" if queued is not None else ""
    return f'<div class="banner banner-saved">✓ {html.escape(text)}{sync}</div>'

def _scan_result_banner_html(body, status, confirmed=False):
    """Returns (html, countdown_seconds). Pure, so the drain can render a
    response too. `confirmed`: this scan was the second badge of a close."""
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
            return f'<div class="banner banner-warning">⚠️ {warn}</div>', 0
        err = html.escape(body.get("error", "Unknown error"))
        return f'<div class="banner banner-error">✗ Scan failed: {err}</div>', 0

    stype = body.get("type", "")
    # A park created no Visit, so it must not render as a check-in: the green
    # tick plus the "?" a park body has no name for reads as one at arm's
    # length. Amber says captured-but-not-complete -- recorded for review.
    if stype == "parked":
        parked = html.escape(body.get("message", "Recorded for review."))
        return f'<div class="banner banner-warning">✓ {parked}</div>', 0
    # The name the person goes by, resolved server-side by the same rule the kiosk
    # roster uses — nickname, else first name, else the part of the address before
    # the @. The raw address is never sent and never shown.
    who = html.escape(str(body.get("participant", {}).get("name") or "?"))
    msg = html.escape(body.get("message", ""))
    label = "CHECKED IN" if stype == "checkin" else "CHECKED OUT"
    if stype == "checkout" and body.get("facilityClosed") and not confirmed:
        return f'<div class="banner banner-ok">✓ {who} — {label}<br>🔒 {html.escape(CLOSING_ALONE_COPY)}</div>', 0
    warning = html.escape(body.get("warning", "")).replace("\n", "<br>")
    if warning:
        # Scan succeeded but the room is short of supervising adults (#1436):
        # amber, and it dwells 12s instead of 5s. Still confirms the scan.
        return f'<div class="banner banner-warning">✓ {who} — {label}<br>⚠️ {warning}</div>', 0
    if msg and msg != "Checked in successfully" and msg != "Checked out successfully":
        return f'<div class="banner banner-ok">✓ {who} — {msg}</div>', 0
    return f'<div class="banner banner-ok">✓ {who} — {label}</div>', 0

def _saved_banner_html(queued, intent=None):
    # A queued scan reads as done and safe to walk away from -- distinct
    # from the red "not saved" state. The displayed direction is the intent
    # of record even when the server has not acked yet.
    label = "CHECKED IN" if intent == "IN" else "CHECKED OUT" if intent == "OUT" else "Saved"
    return f'<div class="banner banner-saved">✓ {label} — will sync ({queued} waiting)</div>'

# Server ids are Postgres int4. A longer read is two badges run together (a
# lost Enter) or a product barcode -- never a person, and must not be queued.
MAX_PARTICIPANT_ID = 2147483647

def _is_valid_participant_id(participant_id):
    raw = str(participant_id)
    return raw.isascii() and raw.isdigit() and 0 < int(raw) <= MAX_PARTICIPANT_ID

def handle_scan(backend, state, outbox, participant_id):
    if not _is_valid_participant_id(participant_id):
        log.warning(f"Rejected malformed scan: {participant_id!r}")
        state.push_event({"html": '<div class="banner banner-error">✗ Badge not read — please scan again</div>'})
        return
    if state.is_repeat_read(participant_id):
        # One scan, filtered before it is queued or sent, so online and offline
        # agree: a double-read never toggles back nor confirms a close. A held
        # badge keeps its own close window open, measured from its last read.
        log.info(f"Ignored repeat read of {participant_id}")
        slid = state.slide_close(participant_id)
        if slid:
            state.push_event(slid)
        return
    client_event_id = new_event_id()
    scanned_at = now_iso()
    clock_suspect = state.clock_watch.check()
    if clock_suspect:
        outbox.mark_clock_suspect()
        log.warning("Large clock step detected; marking queued scans clockSuspect")
    # The kiosk decides a close from what it shows; the server records it as
    # given. A live prompt for THIS badge makes this scan the close; any scan
    # ends the prompt, so another badge is handled as an ordinary scan.
    close = "confirmed" if state.take_local_close(participant_id) else None
    others = []
    if close:
        intent = "OUT"
    else:
        # Displayed direction, from the local presence view, carried with the
        # event. The server must not re-infer it from live state.
        intent = state.displayed_intent(participant_id)
        if intent == "OUT":
            decision, others = state.close_decision(participant_id)
            if decision == "alone":
                close = "alone"
    state.note_presence(participant_id, checking_in=(intent == "IN"))
    roster_as_of = state.roster_as_of if close else None
    if close:
        state.clear_present()

    def show_queued(queued):
        if close:
            state.push_event({"html": _closed_html(close, queued), "queued": queued})
        elif others:
            prompt((state.known_people.get(int(participant_id)) or {}).get("name") or "Keyholder")
        else:
            state.push_event({"html": _saved_banner_html(queued, intent), "queued": queued})

    def prompt(who):
        banner_html = _close_prompt_html(who, state.others_shown(participant_id), state.offline_supervision_warning())
        state.arm_local_close(participant_id, FORCE_CLOSE_CONFIRM_SECONDS, banner_html)
        state.push_event({"html": banner_html, "countdown": FORCE_CLOSE_CONFIRM_SECONDS})

    # A fresh scan must not jump its own predecessor, and nothing goes live
    # until the server speaks this client's protocol (it would drop `close`).
    # Checked before this scan's own row is written.
    queue_only = (outbox.has_pending_for_participant(participant_id)
                  or state.scan_protocol < SCAN_PROTOCOL_VERSION)

    # The row is durable before anything is sent: a restart or power cut during
    # the live POST leaves it for the drain, and the server dedups on
    # clientEventId if the live send did land. A live row is claimed in flight,
    # so the drain skips it until the live outcome settles it.
    outbox.enqueue(
        client_event_id, participant_id, scanned_at,
        intent=intent, clock_suspect=clock_suspect, inflight=not queue_only,
        close=close, roster_as_of=roster_as_of,
    )

    if queue_only:
        show_queued(outbox.pending_count())
        log.info(f"Queued: participant {participant_id} {intent} close={close}")
        return

    try:
        body, status, retry_after = backend.post_scan(
            participant_id,
            client_event_id=client_event_id,
            scanned_at=scanned_at,
            intent=intent,
            clock_suspect=clock_suspect,
            close=close,
            roster_as_of=roster_as_of,
        )
        outcome = classify_response(status, body)
    except BaseException:
        outbox.release(client_event_id)
        raise

    # A live refusal is shown now and settled; only a replay is never refused.
    rejected = outcome == "retry" and status in (400, 404, 409) and body.get("type") != "warming"
    if outcome == "retry" and not rejected:
        # Unconfirmed: the row stays pending for the drain.
        outbox.release(client_event_id)
        show_queued(outbox.pending_count())
        log.warning(f"Scan queued (server unreachable/warming): participant {participant_id} {intent} close={close}")
        return

    # Answered definitively (ack, or a rejection the screen shows now):
    # the row is settled either way and must not replay.
    outbox.ack(client_event_id)

    if outcome == "ack" and close and body.get("facilityClosed") is False and body.get("closePrompt"):
        # Someone checked in after this kiosk's roster was taken: the keyholder
        # left, the building did not close, and the same badge again closes it.
        banner_html = _held_close_html(str(body.get("participant", {}).get("name") or "Keyholder"),
                                       str(body["closePrompt"]))
        state.arm_local_close(participant_id, FORCE_CLOSE_CONFIRM_SECONDS, banner_html)
        state.push_event({"html": banner_html, "countdown": FORCE_CLOSE_CONFIRM_SECONDS})
    elif outcome == "ack" and close and body.get("facilityClosed"):
        state.push_event({"html": _closed_html(close)})
    elif outcome == "ack" and close and body.get("closeRefused"):
        # Only a keyholder closes: the server refused this badge's close and
        # checked it out as itself. The kiosk stops offering it the close.
        state.forget_keyholder(participant_id)
        banner_html, countdown = _scan_result_banner_html(body, status)
        state.push_event({"html": banner_html, "countdown": countdown})
    elif outcome == "ack" and others and body.get("type") == "checkout":
        prompt(str(body.get("participant", {}).get("name") or "Keyholder"))
    else:
        banner_html, countdown = _scan_result_banner_html(body, status)
        state.push_event({"html": banner_html, "countdown": countdown})

    if outcome == "ack":
        ptype = body.get("type", "?")
        who = body.get("participant", {}).get("name") or "?"
        log.info(f"Scan result: {ptype.upper()} — {who}")
    else:
        log.warning(f"Scan rejected, not queued: {body.get('error', body)}")

    # Fetch fresh attendance and push update for the iframe
    if backend.attendance_path and outcome == "ack":
        pending, seq = state.roster_snapshot(outbox)
        att_data, att_status = backend.get_attendance()
        if att_status == 200:
            seeded = state.seed_from_attendance(att_data, pending, since_seq=seq)
            event_payload = {"html": ""}
            for key in ("attendance", "counts", "safety"):
                if key in att_data:
                    event_payload[key] = att_data[key]
            if seeded and "counts" in att_data:
                with state.lock:
                    state.current_counts = att_data["counts"]
            state.push_event(event_payload)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def attendance_poller(backend, state, outbox, interval=30, sleep_fn=time.sleep):
    """Background thread that polls attendance counts periodically while
    anyone is inside or occupancy is unknown, pushing the real roster to the
    board when counts change. It pauses while the building is known empty, at
    any hour, so the database can sleep: with one door, every arrival badges
    here and resumes it."""
    while True:
        sleep_fn(interval)
        if building_known_empty(state):
            continue
        pending, seq = state.roster_snapshot(outbox)
        att_data, att_status = backend.get_attendance()
        if att_status == 200 and "counts" in att_data:
            if not state.seed_from_attendance(att_data, pending, since_seq=seq):
                continue
            new_counts = att_data["counts"]
            with state.lock:
                changed = new_counts != state.current_counts
                state.current_counts = new_counts
            if changed:
                log.info(f"Attendance poll: {new_counts.get('total', '?')} present")
                event = {"html": ""}
                for key in ("attendance", "counts", "safety"):
                    if key in att_data:
                        event[key] = att_data[key]
                state.push_event(event)

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

def version_poller(backend, state, outbox, interval=60, state_path=SELF_UPDATE_STATE_FILE):
    """Background thread that checks for client and server version updates.
    The server check is skipped while the kiosk is quiet (known empty, nothing
    queued): any request defers prod's overnight curfew."""
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

        # 1. Check Server Version Update. NOT gated on the init fetch having
        # succeeded: the drain's protocol gate feeds off this poll, and a
        # kiosk that boots while the backend is down (the exact condition
        # that fills the outbox) must still learn the protocol once the
        # server is back. Queued rows keep the kiosk out of quiet. Self-update
        # below hits no server.
        if not kiosk_quiet(state, outbox):
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

    # Fetch initial attendance state (only if attendance_path is configured).
    # Unseeded (offline, no path), queued scans still set intent.
    pending = outbox.pending_rows()
    seeded = False
    if attendance_path:
        log.info("Fetching initial attendance state...")
        att_data, att_status = backend.get_attendance()
        if att_status == 200 and "counts" in att_data:
            state.current_counts = att_data["counts"]
            state.seed_from_attendance(att_data, pending)
            seeded = True
            log.info(f"Initial state: {state.current_counts['total']} people present")
        else:
            log.warning("Could not fetch initial attendance state")
    if not seeded:
        state.apply_pending(pending)

    if attendance_path:
        # Start background poller for blackout updates
        poller = threading.Thread(target=attendance_poller, args=(backend, state, outbox), daemon=True)
        poller.start()

    # Start version poller thread
    vpoller = threading.Thread(target=version_poller, args=(backend, state, outbox), daemon=True)
    vpoller.start()

    allow_reboot = bool(config.get("allow_reboot", False))
    allow_wifi_bounce = bool(config.get("allow_wifi_bounce", False))
    hmon = threading.Thread(
        target=health_monitor,
        args=(backend_url, state),
        kwargs={"allow_reboot": allow_reboot, "allow_wifi_bounce": allow_wifi_bounce,
                "quiet_fn": lambda: kiosk_quiet(state, outbox)},
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
    KioskHandler.outbox = outbox
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
