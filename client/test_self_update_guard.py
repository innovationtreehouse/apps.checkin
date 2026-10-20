"""Guard against #1616: the self-update exit must not restart-loop when the
Pi's checkout of the target fails."""

import inspect
import os
import tempfile
import unittest
from unittest.mock import patch

from client import (
    _read_last_restart_target,
    _write_last_restart_target,
    _should_restart_for_update,
    self_update_poller,
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
    """Sentinel used to escape self_update_poller's `while True`."""


class TestSelfUpdatePollerLoopGuard(unittest.TestCase):
    """Runs the real self_update_poller loop against a scripted head sequence:
    mismatch -> one restart; non-advancing pull -> no second exit (logged);
    remote moves on -> restart allowed again. Matches issue #1616."""

    def _run(self, head_sequence, state_name="state"):
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
                    self_update_poller(interval=0, state_path=state_path)
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


class TestSelfUpdateReachesNoServer(unittest.TestCase):
    """The self-update loop is git only. Watching the deployed server version is
    the ping loop's job (TestPingPoller in test_client.py), so this thread keeps
    checking the checkout with the backend down and needs no backend at all."""

    def test_the_loop_runs_without_a_backend(self):
        calls = {"n": 0}

        def fake_sleep(_):
            calls["n"] += 1
            if calls["n"] >= 3:
                raise _StopLoop()

        with tempfile.TemporaryDirectory() as d:
            with patch("client.subprocess.run") as fetch, \
                 patch("client.subprocess.check_output", return_value="same\n"), \
                 patch("client.time.sleep", side_effect=fake_sleep):
                with self.assertRaises(_StopLoop):
                    self_update_poller(interval=0, state_path=os.path.join(d, "state"))

        fetch.assert_called()
        self.assertEqual(set(inspect.signature(self_update_poller).parameters),
                         {"interval", "state_path"})


if __name__ == "__main__":
    unittest.main()
