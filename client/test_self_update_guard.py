"""Guard against #1616: version_poller's self-update exit must not
restart-loop when the Pi's checkout of the target fails."""

import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from client import (
    _read_last_restart_target,
    _write_last_restart_target,
    _should_restart_for_update,
    version_poller,
)


class TestShouldRestartForUpdate(unittest.TestCase):
    def test_no_prior_target_restarts(self):
        self.assertTrue(_should_restart_for_update("bbb", None))

    def test_same_target_as_last_restart_does_not_restart(self):
        self.assertFalse(_should_restart_for_update("bbb", "bbb"))

    def test_new_target_past_last_restart_restarts_again(self):
        self.assertTrue(_should_restart_for_update("ccc", "bbb"))


class TestStateFileRoundTrip(unittest.TestCase):
    def test_missing_file_reads_as_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(_read_last_restart_target(os.path.join(d, "state")))

    def test_write_then_read_round_trips(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "state")
            self.assertTrue(_write_last_restart_target("deadbeef", path))
            self.assertEqual(_read_last_restart_target(path), "deadbeef")

    def test_unwritable_path_reports_failure(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "missing-dir", "state")
            with self.assertLogs("kiosk", level="WARNING"):
                self.assertFalse(_write_last_restart_target("deadbeef", path))


class _StopLoop(Exception):
    """Sentinel used to escape version_poller's `while True`."""


class TestVersionPollerLoopGuard(unittest.TestCase):
    """Runs the real version_poller loop against a scripted head sequence:
    mismatch -> one restart; non-advancing pull -> no second exit (logged);
    remote moves on -> restart allowed again. Matches issue #1616."""

    def _run(self, head_sequence, state_name="state"):
        backend = MagicMock()
        backend.get_server_version.return_value = ("v1", 2, 200)
        state = MagicMock()

        # One sleep precedes each loop iteration, so the count names which
        # pair of the sequence is in play; the loop ends when it runs out.
        def fake_sleep(_):
            fake_sleep.n += 1
            if fake_sleep.n > len(head_sequence):
                raise _StopLoop()
        fake_sleep.n = 0

        def fake_check_output(cmd, **kwargs):
            # Target resolution is patched below, so HEAD is the only git
            # read the poller still makes for itself.
            self.assertEqual(cmd[-1], "HEAD")
            return head_sequence[fake_sleep.n - 1][0]

        def fake_update_target():
            return head_sequence[fake_sleep.n - 1][1]

        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, state_name)
            with patch("client.subprocess.run"), \
                 patch("client.subprocess.check_output", side_effect=fake_check_output), \
                 patch("client.resolve_update_target", side_effect=fake_update_target), \
                 patch("client.os._exit") as exit_mock, \
                 patch("client.time.sleep", side_effect=fake_sleep):
                with self.assertRaises(_StopLoop):
                    version_poller(backend, state, interval=0, state_path=state_path)
        return exit_mock

    def test_mismatch_then_stuck_checkout_then_genuine_advance(self):
        heads = [
            ("aaa", "bbb"),  # mismatch, never tried -> restart
            ("aaa", "bbb"),  # HEAD didn't move, same target -> no restart
            ("aaa", "ccc"),  # target moved on -> restart again
        ]
        with self.assertLogs("kiosk", level="WARNING") as logs:
            exit_mock = self._run(heads)

        self.assertEqual(exit_mock.call_count, 2)
        self.assertTrue(any("did not advance" in m for m in logs.output))

    def test_unwritable_state_file_does_not_exit(self):
        """Write failure must keep the client up: exiting without the sha on
        disk leaves the next boot unable to see the attempt (#1616 again)."""
        heads = [("aaa", "bbb"), ("aaa", "bbb")]
        with self.assertLogs("kiosk", level="WARNING") as logs:
            exit_mock = self._run(heads, state_name="missing-dir/state")

        exit_mock.assert_not_called()
        self.assertTrue(any("Not restarting" in m for m in logs.output))


class TestVersionPollerClosedWindow(unittest.TestCase):
    """§3.1: the server-version GET is a keep-alive same as attendance_poller's
    -- it must not fire during the closed window. Self-update (git, no
    network to the server) is unaffected: it's meant to run overnight."""

    def _run(self, in_closed_window_fn, iterations=2):
        backend = MagicMock()
        backend.get_server_version.return_value = ("v1", 2, 200)
        state = MagicMock()

        calls = {"n": 0}

        def fake_sleep(_):
            calls["n"] += 1
            if calls["n"] >= iterations:
                raise _StopLoop()

        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "state")
            with patch("client.subprocess.run") as run_mock, \
                 patch("client.subprocess.check_output", return_value="same\n"), \
                 patch("client.time.sleep", side_effect=fake_sleep):
                with self.assertRaises(_StopLoop):
                    version_poller(backend, state, interval=0, state_path=state_path,
                                   in_closed_window_fn=in_closed_window_fn)
        return backend, run_mock

    def test_swallows_the_version_get_at_2330(self):
        from datetime import datetime
        from outbox import in_closed_window
        backend, run_mock = self._run(lambda: in_closed_window(datetime(2026, 8, 18, 23, 30)))
        # One call during the initial-version bootstrap loop, none from the
        # gated recurring check.
        self.assertEqual(backend.get_server_version.call_count, 1)
        # Self-update (git fetch) is NOT gated -- overnight is its safe window.
        run_mock.assert_called()

    def test_polls_the_version_get_at_1200(self):
        from datetime import datetime
        from outbox import in_closed_window
        backend, _ = self._run(lambda: in_closed_window(datetime(2026, 8, 18, 12, 0)))
        self.assertGreater(backend.get_server_version.call_count, 1)


class TestVersionPollerLateInit(unittest.TestCase):
    """A kiosk that boots while the backend is down must still learn the
    scan protocol once the server returns: the recurring poll is not gated
    on the bootstrap fetch having succeeded, or the drain's protocol gate
    would hold the outbox until a process restart."""

    def test_failed_bootstrap_recovers_on_the_recurring_poll(self):
        backend = MagicMock()
        # Bootstrap window: all failures. Recurring loop: server is back.
        results = [(None, 1, 0)] * 6 + [("v-late", 2, 200)] * 5
        backend.get_server_version.side_effect = results
        state = MagicMock()
        state.scan_protocol = 1

        calls = {"n": 0}

        def fake_sleep(_):
            calls["n"] += 1
            if calls["n"] >= 9:
                raise _StopLoop()

        with tempfile.TemporaryDirectory() as d:
            with patch("client.subprocess.run"),                  patch("client.subprocess.check_output", return_value="same\n"),                  patch("client.time.sleep", side_effect=fake_sleep):
                with self.assertRaises(_StopLoop):
                    version_poller(backend, state, interval=0,
                                   state_path=os.path.join(d, "state"),
                                   in_closed_window_fn=lambda: False)

        self.assertEqual(state.scan_protocol, 2)
        # And the late version is adopted without pushing a reload.
        state.push_event.assert_not_called()


if __name__ == "__main__":
    unittest.main()
