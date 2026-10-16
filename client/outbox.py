"""Durable offline scan queue: SQLite outbox + a single FIFO-by-time replay
thread. Kept separate from client.py so it can be imported without touching
client.py's other background threads."""

import logging
import os
from collections import namedtuple
import random
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone

log = logging.getLogger("kiosk")

# Start at the waker's Retry-After (~30s), exponential to a ~5 min cap.
MIN_BACKOFF_SECONDS = 30
MAX_BACKOFF_SECONDS = 300
# Also the idle-poll interval and the pace between acked events
# -- one knob, not two, since both cap the drain loop's cycle time. ~1
# event/sec leaves the shared 300/min scan rate limit mostly to live scans.
DRAIN_PACE_SECONDS = 1.0
# Guard rail against a pathological stuck state. Un-acked rows are never
# evicted to enforce this -- it is a log-only warning, not a hard cap.
WARN_QUEUE_SIZE = 50_000

# Overnight, 23:00-06:00 local: the health monitor's nightly reboot window,
# with its recovery ladder quiet. Roster, scan and drain traffic ignore it.
CLOSED_WINDOW_START_HOUR = 23  # local time, inclusive
CLOSED_WINDOW_END_HOUR = 6     # local time, exclusive


def in_closed_window(now=None):
    hour = (now or datetime.now()).hour
    if CLOSED_WINDOW_START_HOUR <= CLOSED_WINDOW_END_HOUR:
        return CLOSED_WINDOW_START_HOUR <= hour < CLOSED_WINDOW_END_HOUR
    return hour >= CLOSED_WINDOW_START_HOUR or hour < CLOSED_WINDOW_END_HOUR


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def new_event_id():
    return str(uuid.uuid4())


# One undelivered scan; the field names are also the SELECT's column list.
PendingRow = namedtuple("PendingRow", (
    "client_event_id participant_id scanned_at attempts force_close_token intent "
    "clock_suspect force_close_confirmed close roster_as_of shown_empty"
))


class Outbox:
    """One SQLite file, one table. WAL + synchronous=FULL for
    crash-consistency across the kiosk.sh respawn loop and power cuts."""

    def __init__(self, path="outbox.db"):
        self.path = path
        self._lock = threading.RLock()
        self._conn = self._open(path)
        # Rows a live POST is sending right now. In memory on purpose: after a
        # restart nothing is in flight, so a claimed row the kill interrupted
        # is drainable again.
        self._inflight = set()

    # force_close_token: the confirm token (#1347) the keyholder redeemed before
    # the outage. It rides with the queued event and is sent on drain -- without
    # it the replay lands token-less and parks for review instead of closing.
    _SCHEMA_SQL = """CREATE TABLE IF NOT EXISTS outbox (
        client_event_id  TEXT PRIMARY KEY,
        participant_id   TEXT NOT NULL,
        scanned_at       TEXT NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_status      INTEGER,
        state            TEXT NOT NULL DEFAULT 'pending',
        created_at       TEXT NOT NULL,
        force_close_token TEXT,
        intent           TEXT,
        clock_suspect    INTEGER NOT NULL DEFAULT 0,
        force_close_confirmed INTEGER NOT NULL DEFAULT 0,
        close            TEXT,
        roster_as_of     TEXT,
        shown_empty      INTEGER
    )"""

    def _open(self, path):
        def connect_and_init():
            conn = sqlite3.connect(path, check_same_thread=False)
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=FULL")
                conn.execute(self._SCHEMA_SQL)
                # Kiosks already carry an outbox.db from the pre-token schema.
                try:
                    conn.execute("ALTER TABLE outbox ADD COLUMN force_close_token TEXT")
                except sqlite3.OperationalError:
                    pass  # already there
                try:
                    conn.execute("ALTER TABLE outbox ADD COLUMN intent TEXT")
                except sqlite3.OperationalError:
                    pass
                try:
                    conn.execute(
                        "ALTER TABLE outbox ADD COLUMN clock_suspect INTEGER NOT NULL DEFAULT 0"
                    )
                except sqlite3.OperationalError:
                    pass
                try:
                    conn.execute(
                        "ALTER TABLE outbox ADD COLUMN force_close_confirmed INTEGER NOT NULL DEFAULT 0"
                    )
                except sqlite3.OperationalError:
                    pass
                for column in ("close TEXT", "roster_as_of TEXT", "shown_empty INTEGER"):
                    try:
                        conn.execute(f"ALTER TABLE outbox ADD COLUMN {column}")
                    except sqlite3.OperationalError:
                        pass
                # Rows an older client dead-lettered replay like any other: the
                # server parks what it cannot apply.
                conn.execute("UPDATE outbox SET state='pending' WHERE state='dead'")
                conn.commit()
            except sqlite3.DatabaseError:
                conn.close()
                raise
            return conn

        try:
            return connect_and_init()
        except sqlite3.DatabaseError as e:
            # Scanning must never block on a sick queue: move the corrupt
            # file aside and start fresh.
            corrupt_path = f"{path}.corrupt.{int(time.time())}"
            log.error(f"Outbox {path} unreadable ({e}); moving aside to {corrupt_path}")
            try:
                os.replace(path, corrupt_path)
            except OSError:
                pass
            return connect_and_init()

    def enqueue(self, client_event_id, participant_id, scanned_at, force_close_token=None,
                intent=None, clock_suspect=False, force_close_confirmed=False, inflight=False,
                close=None, roster_as_of=None, shown_empty=None):
        """Idempotent: a retried enqueue of the same event is a no-op.
        inflight=True claims the row for the live POST in the same locked step,
        so the drain can never pick it up between the write and the claim.
        `close` is the keyholder's close decision ("alone" / "confirmed");
        `roster_as_of` is the server time of the roster it was made from.
        `shown_empty` is an older client's close signal, kept for its queued rows."""
        with self._lock:
            if inflight:
                self._inflight.add(client_event_id)
            self._conn.execute(
                "INSERT OR IGNORE INTO outbox "
                "(client_event_id, participant_id, scanned_at, created_at, force_close_token, "
                " intent, clock_suspect, force_close_confirmed, close, roster_as_of, shown_empty) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    client_event_id,
                    str(participant_id),
                    scanned_at,
                    now_iso(),
                    force_close_token,
                    intent,
                    1 if clock_suspect else 0,
                    1 if force_close_confirmed else 0,
                    close,
                    roster_as_of,
                    None if shown_empty is None else int(bool(shown_empty)),
                ),
            )
            self._conn.commit()
            n = self.pending_count()
            if n > WARN_QUEUE_SIZE:
                log.warning(f"Outbox has {n} pending rows -- unusually large backlog")

    def has_pending_for_participant(self, participant_id):
        """A fresh scan must not jump its own predecessor in FIFO order."""
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM outbox WHERE participant_id=? AND state='pending' LIMIT 1",
                (str(participant_id),),
            ).fetchone()
            return row is not None

    def release(self, client_event_id):
        """End the live claim: the row is an ordinary pending row again."""
        with self._lock:
            self._inflight.discard(client_event_id)

    def _not_inflight(self):
        ids = tuple(self._inflight)
        if not ids:
            return "", ()
        return f" AND client_event_id NOT IN ({','.join('?' * len(ids))})", ids

    def pending_count(self):
        """Rows waiting on the drain; a scan still in its live POST is not one."""
        with self._lock:
            clause, args = self._not_inflight()
            return self._conn.execute(
                "SELECT COUNT(*) FROM outbox WHERE state='pending'" + clause, args
            ).fetchone()[0]

    def pending_rows(self, skip_inflight=False):
        """Global FIFO by scanned_at -- trivially preserves per-person order.
        Survives restart: rows persist in the WAL file untouched. In-flight rows
        are included by default: the presence overlay must see them, since the
        roster does not show them yet. The drain skips them."""
        with self._lock:
            clause, args = self._not_inflight() if skip_inflight else ("", ())
            rows = self._conn.execute(
                f"SELECT {', '.join(PendingRow._fields)} "
                "FROM outbox WHERE state='pending'" + clause + " ORDER BY scanned_at ASC",
                args,
            ).fetchall()
            return [PendingRow(*r) for r in rows]

    def mark_clock_suspect(self):
        """A large wall-clock step: queued scans may carry a wrong scannedAt."""
        with self._lock:
            self._conn.execute(
                "UPDATE outbox SET clock_suspect=1 WHERE state='pending'"
            )
            self._conn.commit()

    def ack(self, client_event_id):
        """Server confirmed (2xx, or a dedup/duplicate_ignored response)."""
        with self._lock:
            self._inflight.discard(client_event_id)
            self._conn.execute("DELETE FROM outbox WHERE client_event_id=?", (client_event_id,))
            self._conn.commit()

    def bump_attempt(self, client_event_id, status):
        with self._lock:
            self._conn.execute(
                "UPDATE outbox SET attempts = attempts + 1, last_status=? WHERE client_event_id=?",
                (status, client_event_id),
            )
            self._conn.commit()


def classify_response(status, body):
    """Maps a scan response to ack (delete) or retry (keep, backoff). A server
    speaking the drain's protocol parks a replay it cannot apply rather than
    refusing it, so anything else is a retry -- never a dropped scan."""
    # F2: check first, regardless of status -- post_scan normalizes a
    # non-JSON body (waker HTML, captive portal login, ...) to this sentinel,
    # preserving the intermediary's real status (often 200, not 400), so
    # gating on status alone would falsely ack an unrecorded scan.
    if isinstance(body, dict) and body.get("type") == "warming":
        return "retry"
    if status in (200, 201):
        # checkin | checkout | duplicate_ignored | ignored_debounce | parked
        return "ack"
    if status == 400 and isinstance(body, dict) and body.get("type") == "warning":
        return "ack"  # force-close caution; the touch WAS recorded server-side
    return "retry"


def _backoff_seconds(retry_after_header, current_backoff):
    try:
        base = float(retry_after_header) if retry_after_header else current_backoff
    except (TypeError, ValueError):
        base = current_backoff
    base = max(MIN_BACKOFF_SECONDS, min(base, MAX_BACKOFF_SECONDS))
    jitter = base * random.uniform(-0.1, 0.1)
    return max(1.0, base + jitter)


def replay_drain(outbox, send_fn, push_fn=None, sleep_fn=time.sleep, protocol_ok_fn=lambda: True):
    """Single drain thread: pulls pending rows in scanned_at order,
    resubmits each one (send_fn re-signs per call), and applies the
    ack/retry outcome. Runs forever; call in a background thread."""
    backoff = MIN_BACKOFF_SECONDS
    protocol_hold_logged = False
    while True:
        # Deploy-order race: a server that hasn't advertised the replay
        # generation would misread these rows as live toggles. Hold the
        # queue (rows keep) until kiosk-version says it's safe. Logged on
        # entry so ops can tell a held queue from an empty or offline one.
        if not protocol_ok_fn():
            if not protocol_hold_logged:
                log.warning("Outbox drain held: server has not advertised the replay protocol")
                protocol_hold_logged = True
            sleep_fn(DRAIN_PACE_SECONDS)
            continue
        if protocol_hold_logged:
            log.info("Outbox drain resumed: server advertises the replay protocol")
            protocol_hold_logged = False

        rows = outbox.pending_rows(skip_inflight=True)
        if not rows:
            backoff = MIN_BACKOFF_SECONDS
            sleep_fn(DRAIN_PACE_SECONDS)
            continue

        row = rows[0]
        # replay=True is what tells the server this is a redelivery: the live
        # attempt may already have sent this clientEventId (the row is written
        # before it), so only the drain may trip the replay-only guards. `close`
        # is the keyholder's close decision, applied at scanned_at however late,
        # with the roster time it was made from. A row queued by an older client
        # carries its close as a token, force_close_confirmed or shown_empty
        # instead, which the server reads the same way. Intent is the direction the kiosk
        # displayed; the server must not re-toggle from live state.
        body, status, retry_after = send_fn(
            row.participant_id,
            force_close_token=row.force_close_token,
            client_event_id=row.client_event_id,
            scanned_at=row.scanned_at,
            replay=True,
            intent=row.intent,
            clock_suspect=bool(row.clock_suspect),
            force_close_confirmed=bool(row.force_close_confirmed),
            close=row.close,
            roster_as_of=row.roster_as_of,
            shown_empty=None if row.shown_empty is None else bool(row.shown_empty),
        )
        outcome = classify_response(status, body)

        if outcome == "ack":
            outbox.ack(row.client_event_id)
            backoff = MIN_BACKOFF_SECONDS
            if push_fn:
                push_fn({"html": "", "queued": outbox.pending_count()})
            sleep_fn(DRAIN_PACE_SECONDS)
        else:
            outbox.bump_attempt(row.client_event_id, status)
            wait = _backoff_seconds(retry_after, backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
            sleep_fn(wait)
