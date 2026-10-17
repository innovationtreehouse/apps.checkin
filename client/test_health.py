import os
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

import requests

import health


class TestDiagnose(unittest.TestCase):
    def test_200_is_ok(self):
        get = Mock(return_value=SimpleNamespace(status_code=200))
        self.assertEqual(health.diagnose("http://x", get_fn=get, gateway_fn=lambda: True), health.OK)

    def test_503_is_warming(self):
        get = Mock(return_value=SimpleNamespace(status_code=503))
        self.assertEqual(health.diagnose("http://x", get_fn=get, gateway_fn=lambda: True), health.WARMING)

    def test_connection_error_without_gateway_is_L2(self):
        get = Mock(side_effect=requests.exceptions.ConnectionError("down"))
        self.assertEqual(health.diagnose("http://x", get_fn=get, gateway_fn=lambda: False), health.L2)

    def test_connection_error_with_gateway_is_L4(self):
        get = Mock(side_effect=requests.exceptions.ConnectionError("down"))
        self.assertEqual(health.diagnose("http://x", get_fn=get, gateway_fn=lambda: True), health.L4)

    def test_timeout_with_gateway_is_L4(self):
        get = Mock(side_effect=requests.exceptions.Timeout())
        self.assertEqual(health.diagnose("http://x", get_fn=get, gateway_fn=lambda: True), health.L4)


class TestHealthMonitorTick(unittest.TestCase):
    def test_silent_through_closed_window(self):
        state = Mock()
        mon = health.HealthMonitor("http://x", state)
        called = {"n": 0}

        def diagnose_fn(_url):
            called["n"] += 1
            return health.OK

        self.assertIsNone(mon.tick(diagnose_fn=diagnose_fn, in_closed_fn=lambda: True))
        self.assertEqual(called["n"], 0)

    def test_silent_while_the_kiosk_is_quiet(self):
        """A probe every 30 s would keep prod's curfew from firing."""
        state = Mock()
        mon = health.HealthMonitor("http://x", state)
        diagnose_fn = Mock(return_value=health.OK)
        self.assertIsNone(mon.tick(diagnose_fn=diagnose_fn, in_closed_fn=lambda: False, quiet_fn=lambda: True))
        diagnose_fn.assert_not_called()
        state.push_event.assert_not_called()

    def test_probes_when_not_quiet(self):
        mon = health.HealthMonitor("http://x", Mock(last_browser_seen=None))
        diagnose_fn = Mock(return_value=health.OK)
        mon.tick(diagnose_fn=diagnose_fn, in_closed_fn=lambda: False, quiet_fn=lambda: False)
        diagnose_fn.assert_called_once()

    def test_does_not_wifi_bounce_on_L4(self):
        state = Mock()
        mon = health.HealthMonitor("http://x", state, allow_wifi_bounce=True)
        with patch.object(health, "_wifi_bounce") as bounce:
            mon.tick(now=1000, diagnose_fn=lambda _u: health.L4, in_closed_fn=lambda: False)
            bounce.assert_not_called()

    def test_wifi_bounce_on_L2_when_enabled(self):
        state = Mock()
        mon = health.HealthMonitor("http://x", state, allow_wifi_bounce=True)
        with patch.object(health, "_wifi_bounce") as bounce:
            mon.tick(now=1000, diagnose_fn=lambda _u: health.L2, in_closed_fn=lambda: False)
            bounce.assert_called_once()


class TestRecoveryLadder(unittest.TestCase):
    def _state(self, last_browser_seen=0.0, scanner_ok=True):
        events = []
        state = SimpleNamespace(
            last_browser_seen=last_browser_seen,
            last_attendance_ok=None,
            attendance_auth_fail=False,
            scanner_ok=scanner_ok,
            push_event=events.append,
        )
        return state, events

    def test_no_full_cycle_inside_bounce_grace(self):
        state, _ = self._state()
        mon = health.HealthMonitor("http://x", state)
        mon.last_chromium_bounce = 1000
        with patch.object(health.os, "_exit") as ex:
            mon.tick(now=1000 + health.BOUNCE_GRACE_SECONDS - 1,
                     diagnose_fn=lambda _u: health.OK, in_closed_fn=lambda: False)
            ex.assert_not_called()

    def test_full_cycle_after_grace_records_strike(self):
        state, _ = self._state()
        mon = health.HealthMonitor("http://x", state)
        mon.last_chromium_bounce = 1000
        with tempfile.TemporaryDirectory() as d:
            strike_file = os.path.join(d, "strikes")
            with patch.object(health, "FULL_CYCLE_SENTINEL", strike_file), \
                 patch.object(health.os, "_exit") as ex:
                mon.tick(now=1200, diagnose_fn=lambda _u: health.OK, in_closed_fn=lambda: False)
                ex.assert_called_once()
            with open(strike_file) as f:
                self.assertEqual(len(f.read().split()), 1)

    def test_repeated_full_cycles_escalate_to_reboot(self):
        state, _ = self._state()
        mon = health.HealthMonitor("http://x", state, allow_reboot=True)
        mon.last_chromium_bounce = 4800
        with tempfile.TemporaryDirectory() as d:
            strike_file = os.path.join(d, "strikes")
            with open(strike_file, "w") as f:
                f.write(f"{time.time() - 60}\n{time.time() - 30}")
            with patch.object(health, "FULL_CYCLE_SENTINEL", strike_file), \
                 patch.object(health, "_reboot") as reboot, \
                 patch.object(health.os, "_exit") as ex:
                mon.tick(now=5000, diagnose_fn=lambda _u: health.OK, in_closed_fn=lambda: False)
                reboot.assert_called_once()
                ex.assert_not_called()

    def test_persistent_L2_escalates_after_wifi_bounces(self):
        state, _ = self._state()
        mon = health.HealthMonitor("http://x", state, allow_reboot=True)
        with patch.object(health, "_reboot") as reboot:
            mon.tick(now=5000, diagnose_fn=lambda _u: health.L2, in_closed_fn=lambda: False)
            reboot.assert_not_called()
            mon.tick(now=5000 + health.ESCALATION_AFTER_SECONDS,
                     diagnose_fn=lambda _u: health.L2, in_closed_fn=lambda: False)
            reboot.assert_called_once()

    def test_ok_resets_degradation_clock(self):
        state, _ = self._state(last_browser_seen=6000.0)
        mon = health.HealthMonitor("http://x", state, allow_reboot=True)
        mon.tick(now=5000, diagnose_fn=lambda _u: health.L2, in_closed_fn=lambda: False)
        mon.tick(now=6000, diagnose_fn=lambda _u: health.OK, in_closed_fn=lambda: False)
        self.assertIsNone(mon.degraded_since)

    def test_scanner_down_surfaces_banner(self):
        state, events = self._state(last_browser_seen=1000.0, scanner_ok=False)
        mon = health.HealthMonitor("http://x", state)
        mon.tick(now=1000, diagnose_fn=lambda _u: health.OK, in_closed_fn=lambda: False)
        self.assertTrue(any("Scanner" in e.get("html", "") for e in events))


if __name__ == "__main__":
    unittest.main()
