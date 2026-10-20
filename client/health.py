"""Kiosk health monitor: one cookieless GET /api/health, failure-mode routed
to layers L2–L5, plus local L1 scanner and recovery ladder rungs.

Runs on its interval around the clock. L6 (DB) is observed from scan outcomes,
never polled.
"""

import logging
import os
import socket
import subprocess
import time
from datetime import datetime
from urllib.parse import urlparse

import requests

log = logging.getLogger("kiosk")

CHROMIUM_BOUNCE_SENTINEL = ".chromium-bounce"
FULL_CYCLE_SENTINEL = ".full-cycle-times"
PROBE_PATH = "/api/health"
PROBE_TIMEOUT = 5
OPEN_HOURS_INTERVAL = 30
WEDGE_SILENCE_SECONDS = 150
ATTENDANCE_STALE_SECONDS = 180
CHROMIUM_COOLDOWN = 300
BOUNCE_GRACE_SECONDS = 180  # cold-Pi Chromium relaunch + first paint can exceed the wedge threshold
FULL_CYCLE_COOLDOWN = 300
FULL_CYCLE_STRIKE_WINDOW = 3600
FULL_CYCLE_STRIKE_LIMIT = 2
WIFI_COOLDOWN = 300
ESCALATION_AFTER_SECONDS = 900
ESCALATION_REBOOT_COOLDOWN = 3600
WARMING_CAP_SECONDS = 600
NIGHTLY_REBOOT_HOUR = 3  # local

L2, L3, L4, L5, WARMING, OK = "L2", "L3", "L4", "L5", "warming", "ok"


def _gateway_reachable():
    """True when a default route exists. Used to tell L2 (LAN) from L4 (upstream)."""
    try:
        with open("/proc/net/route") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[1] == "00000000":
                    return True
    except OSError:
        pass
    return False


def diagnose(base_url, get_fn=requests.get, gateway_fn=_gateway_reachable):
    """One GET /api/health. The failure mode is the layer."""
    url = base_url.rstrip("/") + PROBE_PATH
    try:
        r = get_fn(url, timeout=PROBE_TIMEOUT)
    except socket.gaierror:
        return L3
    except requests.exceptions.SSLError:
        return L4
    except (requests.exceptions.ConnectTimeout, requests.exceptions.Timeout):
        return L4 if gateway_fn() else L2
    except requests.exceptions.ConnectionError as e:
        if isinstance(getattr(e, "args", [None])[0], socket.gaierror):
            return L3
        return L2 if not gateway_fn() else L4
    except Exception as e:
        log.warning("health probe error: %s", e)
        return L4 if gateway_fn() else L2

    if r.status_code == 200:
        return OK
    if r.status_code == 503:
        return WARMING
    if 500 <= r.status_code < 600:
        return L5
    return L5


def _write_sentinel(path=CHROMIUM_BOUNCE_SENTINEL):
    try:
        with open(path, "w") as f:
            f.write(str(time.time()))
        return True
    except OSError as e:
        log.warning("could not write chromium-bounce sentinel: %s", e)
        return False


def _wifi_bounce():
    try:
        subprocess.run(["nmcli", "networking", "off"], check=False, timeout=10)
        time.sleep(2)
        subprocess.run(["nmcli", "networking", "on"], check=False, timeout=10)
        return True
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning("wifi bounce failed: %s", e)
        return False


def _reboot():
    try:
        subprocess.run(["sudo", "-n", "reboot"], check=False, timeout=10)
        return True
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning("reboot failed: %s", e)
        return False


class HealthMonitor:
    def __init__(self, base_url, state, allow_reboot=False, allow_wifi_bounce=False):
        self.base_url = base_url
        self.state = state
        self.allow_reboot = allow_reboot
        self.allow_wifi_bounce = allow_wifi_bounce
        self.layer = OK
        self.warming_since = None
        self.degraded_since = None
        self.last_chromium_bounce = 0.0
        self.last_full_cycle = 0.0
        self.last_wifi_bounce = 0.0
        self.last_escalation_reboot = 0.0
        self.last_nightly_date = None
        self._host = urlparse(base_url).hostname

    def tick(self, now=None, diagnose_fn=None):
        now = now or time.monotonic()
        self._nightly_reboot_if_due()

        result = (diagnose_fn or diagnose)(self.base_url)
        self.layer = result
        if result not in (L2, L3):
            self.degraded_since = None

        if result == WARMING:
            if self.warming_since is None:
                self.warming_since = now
            if now - self.warming_since > WARMING_CAP_SECONDS:
                self.state.push_event({
                    "html": '<div class="banner banner-error">✗ Server not recovering</div>',
                })
            else:
                self.state.push_event({
                    "html": '<div class="banner banner-warning">Server waking (~1 min)…</div>',
                })
            return result
        self.warming_since = None

        if result == OK:
            if getattr(self.state, "scanner_ok", True) is False:
                self.state.push_event({
                    "html": '<div class="banner banner-error">✗ Scanner disconnected — badge scans will not register</div>',
                })
            self._maybe_wedge(now)
            return result

        if result in (L2, L3):
            if self.degraded_since is None:
                self.degraded_since = now
            elif now - self.degraded_since >= ESCALATION_AFTER_SECONDS:
                self.escalate(now)
            if self.allow_wifi_bounce and now - self.last_wifi_bounce >= WIFI_COOLDOWN:
                log.warning("L2/L3 — bouncing wifi")
                self.last_wifi_bounce = now
                _wifi_bounce()
            return result

        # L4/L5: upstream — report only. Neither a wifi bounce nor a reboot
        # can fix the far side, so no ladder rung fires here.
        return result

    def _maybe_wedge(self, now):
        last_browser = getattr(self.state, "last_browser_seen", None)
        if last_browser is None:
            return
        silence = now - last_browser
        if silence < WEDGE_SILENCE_SECONDS:
            return
        last_att = getattr(self.state, "last_attendance_ok", None)
        if last_att is not None and now - last_att < ATTENDANCE_STALE_SECONDS:
            return
        if getattr(self.state, "attendance_auth_fail", False):
            self.state.push_event({
                "html": '<div class="banner banner-warning">Kiosk signature rejected — check clock/key</div>',
            })
            return
        if now - self.last_chromium_bounce < CHROMIUM_COOLDOWN:
            if (now - self.last_chromium_bounce >= BOUNCE_GRACE_SECONDS
                    and now - self.last_full_cycle >= FULL_CYCLE_COOLDOWN):
                # A full cycle restarts this process, so the strike count that
                # decides "cycling isn't working, reboot" has to live on disk.
                if self._full_cycle_strikes() >= FULL_CYCLE_STRIKE_LIMIT and self.escalate(now):
                    return
                log.warning("browser still wedged after Chromium bounce — full cycle")
                self.last_full_cycle = now
                self._record_full_cycle()
                os._exit(0)
            return
        log.warning("browser silent %.0fs — Chromium bounce", silence)
        self.last_chromium_bounce = now
        self.state.push_event({"reload": True})
        _write_sentinel()

    def _nightly_reboot_if_due(self):
        if not self.allow_reboot:
            return
        hour = datetime.now().hour
        today = datetime.now().date()
        if hour != NIGHTLY_REBOOT_HOUR or self.last_nightly_date == today:
            return
        self.last_nightly_date = today
        log.warning("nightly reboot")
        _reboot()

    def _full_cycle_strikes(self):
        try:
            with open(FULL_CYCLE_SENTINEL) as f:
                stamps = [float(x) for x in f.read().split()]
        except (OSError, ValueError):
            return 0
        return sum(1 for s in stamps if time.time() - s < FULL_CYCLE_STRIKE_WINDOW)

    def _record_full_cycle(self):
        now_wall = time.time()
        stamps = []
        try:
            with open(FULL_CYCLE_SENTINEL) as f:
                stamps = [float(x) for x in f.read().split()]
        except (OSError, ValueError):
            pass
        stamps = [s for s in stamps if now_wall - s < FULL_CYCLE_STRIKE_WINDOW]
        stamps.append(now_wall)
        try:
            with open(FULL_CYCLE_SENTINEL, "w") as f:
                f.write("\n".join(str(s) for s in stamps))
        except OSError as e:
            log.warning("could not record full cycle: %s", e)

    def escalate(self, now=None):
        now = now or time.monotonic()
        if not self.allow_reboot:
            return False
        if now - self.last_escalation_reboot < ESCALATION_REBOOT_COOLDOWN:
            return False
        self.last_escalation_reboot = now
        log.warning("escalation reboot (ladder exhausted)")
        _reboot()
        return True


def health_monitor(backend_url, state, interval=OPEN_HOURS_INTERVAL,
                   sleep_fn=time.sleep, allow_reboot=False, allow_wifi_bounce=False):
    monitor = HealthMonitor(backend_url, state, allow_reboot, allow_wifi_bounce)
    while True:
        sleep_fn(interval)
        try:
            monitor.tick()
        except Exception as e:
            log.warning("health_monitor tick failed: %s", e)
