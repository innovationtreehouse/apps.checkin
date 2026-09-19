"""Tests for the offline scan queue: durability across restart, ordered
replay, no-double-submit under the idempotency rules, and the queued/offline
banner (#1257)."""

import os
import tempfile
import unittest
from unittest.mock import MagicMock

from outbox import (Outbox, classify_response, replay_drain, new_event_id, now_iso,
                    in_closed_window, MIN_BACKOFF_SECONDS, DRAIN_PACE_SECONDS)
from client import handle_scan, _saved_banner_html, ClockWatch


class _StopLoop(Exception):
    """Sentinel to escape replay_drain's `while True` in tests."""


class FakeState:
    def __init__(self, confirm_token=None):
        self.events = []
        self.confirm_token = confirm_token
        self.clock_watch = ClockWatch()
        self.present_ids = set()

    def push_event(self, data):
        self.events.append(data)

    def take_confirm(self):
        token, self.confirm_token = self.confirm_token, None
        return token

    def displayed_intent(self, participant_id):
        return "IN"

    def note_presence(self, participant_id, checking_in, is_keyholder=None):
        return

    def seed_from_attendance(self, att_data):
        return

    def take_local_close(self, participant_id):
        return False

    def arm_local_close(self, participant_id, seconds):
        return

    def offline_last_keyholder(self, participant_id):
        return False

    def offline_supervision_warning(self):
        return None


class TestOutboxDurability(unittest.TestCase):
    def test_pending_rows_survive_process_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "outbox.db")
            ob1 = Outbox(path)
            ob1.enqueue("evt-1", "42", "2026-08-18T10:00:00+00:00")

            # Simulate a restart: a fresh Outbox instance over the same file.
            ob2 = Outbox(path)
            rows = ob2.pending_rows()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0][0], "evt-1")

    def test_enqueue_persists_intent_and_clock_suspect(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "outbox.db")
            ob = Outbox(path)
            ob.enqueue("evt-1", "42", "2026-08-18T10:00:00+00:00", intent="IN", clock_suspect=True)
            row = ob.pending_rows()[0]
            self.assertEqual(row[5], "IN")
            self.assertEqual(row[6], 1)
            ob.mark_clock_suspect()
            self.assertEqual(ob.pending_rows()[0][6], 1)

    def test_corrupt_file_moved_aside_and_queue_still_usable(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "outbox.db")
            with open(path, "wb") as f:
                f.write(b"not a sqlite file at all, definitely corrupt\x00\x01")

            ob = Outbox(path)  # must not raise, must not block scanning
            ob.enqueue("evt-1", "1", now_iso())
            self.assertEqual(ob.pending_count(), 1)

            corrupt_files = [f for f in os.listdir(d) if ".corrupt." in f]
            self.assertEqual(len(corrupt_files), 1)


class TestOutboxOrderingAndDedup(unittest.TestCase):
    def test_pending_rows_ordered_by_scanned_at(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-b", "1", "2026-08-18T10:05:00+00:00")
            ob.enqueue("evt-a", "2", "2026-08-18T10:00:00+00:00")
            ob.enqueue("evt-c", "3", "2026-08-18T10:10:00+00:00")

            ids = [r[0] for r in ob.pending_rows()]
            self.assertEqual(ids, ["evt-a", "evt-b", "evt-c"])

    def test_enqueue_same_event_id_twice_is_a_noop(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())
            ob.enqueue("evt-1", "1", now_iso())
            self.assertEqual(ob.pending_count(), 1)

    def test_has_pending_for_participant(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            self.assertFalse(ob.has_pending_for_participant("7"))
            ob.enqueue("evt-1", "7", now_iso())
            self.assertTrue(ob.has_pending_for_participant("7"))
            ob.ack("evt-1")
            self.assertFalse(ob.has_pending_for_participant("7"))

    def test_ack_removes_dead_marks_and_keeps(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())
            ob.enqueue("evt-2", "2", now_iso())

            ob.ack("evt-1")
            ob.mark_dead("evt-2", 404)

            self.assertEqual(ob.pending_rows(), [])
            self.assertEqual(ob.dead_count(), 1)


class TestClassifyResponse(unittest.TestCase):
    def test_ack_cases(self):
        for status, body in [
            (200, {"type": "checkin"}),
            (200, {"type": "checkout"}),
            (200, {"type": "duplicate_ignored"}),
            (200, {"type": "ignored_debounce"}),
            (200, {"type": "parked"}),
            (400, {"type": "warning", "error": "force close caution"}),
        ]:
            self.assertEqual(classify_response(status, body), "ack", (status, body))

    def test_dead_cases(self):
        for status in (400, 404, 409):
            self.assertEqual(classify_response(status, {"error": "nope"}), "dead")

    def test_retry_cases(self):
        for status, body in [
            (0, {"error": "timeout"}),
            (503, {}),
            (429, {}),
            (401, {}),
            (500, {}),
            (502, {}),
            (400, {"type": "warming"}),
            (200, {"type": "warming"}),  # F2: a captive portal's 200 HTML, normalized by post_scan
        ]:
            self.assertEqual(classify_response(status, body), "retry", (status, body))

    def test_warming_sentinel_wins_regardless_of_status(self):
        # F2: post_scan normalizes any non-JSON body (waker HTML, a captive
        # portal's login page, ...) to {"type": "warming"} while preserving
        # whatever status the intermediary sent -- often 200, not 400. A
        # status-gated warming check would let a 200 non-JSON body ack a scan
        # that was never actually recorded server-side.
        for status in (200, 201, 502, 404):
            self.assertEqual(
                classify_response(status, {"type": "warming"}), "retry", status
            )


class TestInClosedWindow(unittest.TestCase):
    def test_wraps_across_midnight(self):
        from datetime import datetime
        self.assertTrue(in_closed_window(datetime(2026, 8, 18, 23, 30)))
        self.assertTrue(in_closed_window(datetime(2026, 8, 18, 2, 0)))
        self.assertFalse(in_closed_window(datetime(2026, 8, 18, 6, 0)))  # end hour is exclusive
        self.assertFalse(in_closed_window(datetime(2026, 8, 18, 12, 0)))


class TestReplayDrain(unittest.TestCase):
    def _run(self, responses):
        """responses: list of (body, status, retry_after) yielded in order by send_fn."""
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            for i in range(len(responses)):
                ob.enqueue(f"evt-{i}", str(i), f"2026-08-18T10:0{i}:00+00:00")

            calls = {"n": 0}

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, **kwargs):
                idx = calls["n"]
                calls["n"] += 1
                return responses[idx]

            sleeps = []

            def fake_sleep(secs):
                sleeps.append(secs)
                if calls["n"] >= len(responses):
                    raise _StopLoop()

            # Pin the window open: these cases test send/classify, not F3, and
            # the real clock would park the drain (and hang the test) whenever
            # the suite runs between 23:00 and 06:00 local. The window has its
            # own test.
            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False)
            return ob

    def test_a_426_version_bounce_is_a_retry_not_a_dead_letter(self):
        # A rolling deploy can land a replay on an instance that does not
        # speak the row's generation yet; the bounce must hold the row.
        self.assertEqual(classify_response(426, {"error": "Unsupported protocolVersion"}), "retry")

    def test_drain_holds_while_server_protocol_is_below_replay_generation(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "42", "2026-08-18T10:00:00+00:00")

            sent = []

            def send_fn(*a, **k):
                sent.append((a, k))
                return {"type": "checkin"}, 200, None

            ticks = {"n": 0}

            def fake_sleep(_secs):
                ticks["n"] += 1
                if ticks["n"] >= 3:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False,
                             protocol_ok_fn=lambda: False)
            # Nothing sent, nothing lost: the row is held, not dropped.
            self.assertEqual(sent, [])
            self.assertEqual(len(ob.pending_rows()), 1)

            # Server upgrades mid-run: the same drain resumes and delivers.
            ticks["n"] = -10
            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False,
                             protocol_ok_fn=lambda: True)
            self.assertEqual(len(sent), 1)
            self.assertEqual(ob.pending_rows(), [])

    def test_acked_events_are_removed_in_order(self):
        ob = self._run([
            ({"type": "checkin"}, 200, None),
            ({"type": "checkout"}, 200, None),
        ])
        self.assertEqual(ob.pending_rows(), [])

    def test_dead_event_is_marked_and_does_not_block_the_next_one(self):
        ob = self._run([
            ({"error": "unknown participant"}, 404, None),
            ({"type": "checkin"}, 200, None),
        ])
        self.assertEqual(ob.dead_count(), 1)
        self.assertEqual(ob.pending_rows(), [])

    def test_retry_keeps_the_event_pending(self):
        ob = self._run([
            ({}, 503, "30"),
        ])
        self.assertEqual(len(ob.pending_rows()), 1)
        self.assertEqual(ob.pending_rows()[0][3], 1)  # attempts bumped

    def test_does_not_send_during_the_closed_window(self):
        # F3 / D4: a queued POST is non-GET and would wake the curfewed
        # service -- the drain must sleep through the closed window instead
        # of sending.
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())

            send_fn = MagicMock()
            sleeps = {"n": 0}

            def fake_sleep(secs):
                sleeps["n"] += 1
                if sleeps["n"] >= 3:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(
                    ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                    in_closed_window_fn=lambda: True,
                )

            send_fn.assert_not_called()
            self.assertEqual(ob.pending_count(), 1)

    def test_same_client_event_id_reused_across_retries_until_acked(self):
        # The idempotency key must not change between attempts -- a retried
        # send after a warming/network failure is a redelivery of the same
        # event, not a new one, or server-side dedup can't do its job.
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-fixed", "1", now_iso())

            seen_ids = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, **kwargs):
                seen_ids.append(client_event_id)
                if len(seen_ids) < 3:
                    return ({}, 503, None)
                return ({"type": "duplicate_ignored"}, 200, None)

            def fake_sleep(secs):
                if len(seen_ids) >= 3:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False)

            self.assertEqual(seen_ids, ["evt-fixed", "evt-fixed", "evt-fixed"])
            self.assertEqual(ob.pending_rows(), [])


    def test_drain_marks_every_send_as_a_replay(self):
        # The server's replay-only guards (freshness, out-of-order, force-close
        # parking) key on this flag, not on clientEventId -- the live attempt
        # already sent that id.
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())

            seen = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, **kwargs):
                seen.append(replay)
                return ({"type": "checkin"}, 200, None)

            def fake_sleep(secs):
                if seen:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False)

            self.assertEqual(seen, [True])

    def test_drain_replays_the_stored_force_close_token(self):
        # #1347/§5.23a: a confirm the keyholder gave before the outage still
        # closes when it lands, and that only works if the token queued with it
        # is sent on the replay. Without it the server parks the close.
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-tok", "1", now_iso(), "tok-1")
            ob.enqueue("evt-none", "2", now_iso())

            seen = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, **kwargs):
                seen.append((client_event_id, force_close_token))
                return ({"type": "checkout"}, 200, None)

            def fake_sleep(secs):
                if len(seen) >= 2:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False)

            self.assertEqual(seen, [("evt-tok", "tok-1"), ("evt-none", None)])

    def test_dead_letter_refreshes_the_queue_badge(self):
        # A queue that empties by dead-lettering must not leave a stale count
        # on screen -- same push the ack branch does.
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())

            pushed = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, **kwargs):
                return ({"error": "unknown participant"}, 404, None)

            def fake_sleep(secs):
                if pushed:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=pushed.append, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False)

            self.assertEqual(pushed[0]["queued"], 0)


class TestDeadLetterDrainPass(unittest.TestCase):
    """#1347 PR-2 / Q10: once the pending FIFO empties, a second pass
    retires dead-lettered rows to the server-side DLQ."""

    def test_dead_pass_sends_after_pending_drains_and_deletes_on_2xx(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())
            ob.mark_dead("evt-1", 404)

            seen = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, dead=False, dead_status=None, **kwargs):
                seen.append((client_event_id, dead, dead_status))
                return ({"type": "parked"}, 200, None)

            def fake_sleep(secs):
                if seen:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False)

            self.assertEqual(seen, [("evt-1", True, 404)])
            self.assertEqual(ob.dead_count(), 0)  # deleted, not merely re-marked

    def test_dead_pass_keeps_the_row_on_failure(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())
            ob.mark_dead("evt-1", 404)

            calls = {"n": 0}

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, dead=False, dead_status=None, **kwargs):
                calls["n"] += 1
                return ({"error": "still down"}, 500, None)

            def fake_sleep(secs):
                if calls["n"] >= 2:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False)

            self.assertEqual(ob.dead_count(), 1)  # still there for next cycle

    def test_dead_pass_failure_logs_and_backs_off(self):
        # A permanently-failing dead row (participant deleted -> DLQ ingest
        # 404s) must not silently retry at the 1s drain pace forever: each
        # failure logs a warning and the wait grows exponentially from
        # MIN_BACKOFF_SECONDS, mirroring the pending path.
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())
            ob.mark_dead("evt-1", 404)

            waits = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, dead=False, dead_status=None, **kwargs):
                return ({"error": "person gone"}, 404, None)

            def fake_sleep(secs):
                waits.append(secs)
                if len(waits) >= 2:
                    raise _StopLoop()

            with self.assertLogs("kiosk", level="WARNING") as captured:
                with self.assertRaises(_StopLoop):
                    replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                                 in_closed_window_fn=lambda: False)

            self.assertTrue(any("evt-1" in m and "404" in m for m in captured.output))
            # Both waits are backoff-scale, not the 1s pace; the second grew.
            # _backoff_seconds jitters +/-10%, so compare against 0.9x floors.
            self.assertGreaterEqual(waits[0], MIN_BACKOFF_SECONDS * 0.9)
            self.assertGreaterEqual(waits[1], MIN_BACKOFF_SECONDS * 2 * 0.9)
            self.assertEqual(ob.dead_count(), 1)  # kept, never evicted

    def test_dead_pass_backoff_resets_after_success(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", "2026-08-18T10:00:00+00:00")
            ob.enqueue("evt-2", "2", "2026-08-18T10:01:00+00:00")
            ob.mark_dead("evt-1", 404)
            ob.mark_dead("evt-2", 409)

            outcomes = iter([500, 200, 200])
            waits = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, dead=False, dead_status=None, **kwargs):
                return ({}, next(outcomes), None)

            def fake_sleep(secs):
                waits.append(secs)
                if len(waits) >= 3:
                    raise _StopLoop()

            with self.assertLogs("kiosk", level="WARNING"):
                with self.assertRaises(_StopLoop):
                    replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                                 in_closed_window_fn=lambda: False)

            # fail (backoff wait), success (pace), success (pace) -- and both
            # rows retired despite the first attempt failing.
            self.assertGreaterEqual(waits[0], MIN_BACKOFF_SECONDS * 0.9)
            self.assertEqual(waits[1], DRAIN_PACE_SECONDS)
            self.assertEqual(waits[2], DRAIN_PACE_SECONDS)
            self.assertEqual(ob.dead_count(), 0)

    def test_dead_pass_rotates_past_a_failing_row(self):
        # #1727: a terminally-refused row must not head-of-line-block the
        # dead rows behind it — after a failure, the next cycle tries the
        # next row (never-tried before retried), round-robin thereafter.
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-stuck", "1", "2026-08-18T10:00:00+00:00")
            ob.enqueue("evt-next", "2", "2026-08-18T10:01:00+00:00")
            ob.mark_dead("evt-stuck", 404)
            ob.mark_dead("evt-next", 409)

            seen = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, dead=False, dead_status=None, **kwargs):
                seen.append(client_event_id)
                return ({"error": "refused"}, 400, None)

            def fake_sleep(secs):
                if len(seen) >= 4:
                    raise _StopLoop()

            with self.assertLogs("kiosk", level="WARNING"):
                with self.assertRaises(_StopLoop):
                    replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                                 in_closed_window_fn=lambda: False)

            # oldest-first for the never-tried, then alternating — not
            # evt-stuck four times.
            self.assertEqual(seen[:2], ["evt-stuck", "evt-next"])
            self.assertEqual(set(seen[2:4]), {"evt-stuck", "evt-next"})
            self.assertEqual(ob.dead_count(), 2)

    def test_dead_pass_rotation_still_deletes_on_success(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-stuck", "1", "2026-08-18T10:00:00+00:00")
            ob.enqueue("evt-ok", "2", "2026-08-18T10:01:00+00:00")
            ob.mark_dead("evt-stuck", 404)
            ob.mark_dead("evt-ok", 409)

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, dead=False, dead_status=None, **kwargs):
                if client_event_id == "evt-stuck":
                    return ({"error": "refused"}, 400, None)
                return ({}, 200, None)

            sleeps = {"n": 0}

            def fake_sleep(secs):
                sleeps["n"] += 1
                if sleeps["n"] >= 3:
                    raise _StopLoop()

            with self.assertLogs("kiosk", level="WARNING"):
                with self.assertRaises(_StopLoop):
                    replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                                 in_closed_window_fn=lambda: False)

            # evt-ok retired via rotation even though evt-stuck keeps failing
            self.assertEqual(ob.dead_count(), 1)

    def test_dead_pass_never_jumps_the_pending_fifo(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-pending", "1", "2026-08-18T10:00:00+00:00")
            ob.enqueue("evt-to-die", "2", "2026-08-18T10:01:00+00:00")
            ob.mark_dead("evt-to-die", 404)

            seen = []

            def send_fn(participant_id, force_close_token=None, client_event_id=None,
                        scanned_at=None, replay=False, dead=False, dead_status=None, **kwargs):
                seen.append((client_event_id, dead))
                return ({"type": "checkin"}, 200, None)

            def fake_sleep(secs):
                if seen:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: False)

            # Only the pending row goes out this cycle -- the dead pass never
            # competes with it for the one-send-per-cycle pace.
            self.assertEqual(seen, [("evt-pending", False)])

    def test_dead_pass_is_silent_in_the_closed_window(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            ob.enqueue("evt-1", "1", now_iso())
            ob.mark_dead("evt-1", 404)

            send_fn = MagicMock()
            sleeps = {"n": 0}

            def fake_sleep(secs):
                sleeps["n"] += 1
                if sleeps["n"] >= 3:
                    raise _StopLoop()

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             in_closed_window_fn=lambda: True)

            send_fn.assert_not_called()
            self.assertEqual(ob.dead_count(), 1)


class TestHandleScanQueuesOnFailure(unittest.TestCase):
    def _backend(self, post_scan_return, attendance_path=None):
        backend = MagicMock()
        backend.post_scan.return_value = post_scan_return
        backend.attendance_path = attendance_path
        return backend

    def test_network_failure_queues_and_shows_saved_banner(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            backend = self._backend(({"error": "Connection refused"}, 0, None))
            state = FakeState()

            handle_scan(backend, state, ob, "9")

            self.assertEqual(ob.pending_count(), 1)
            self.assertIn("will sync", state.events[-1]["html"])
            self.assertIn("1 waiting", state.events[-1]["html"])

    def test_successful_scan_is_not_queued(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            backend = self._backend((
                {"type": "checkin", "participant": {"email": "a@b.com"}, "message": "Checked in successfully"},
                200,
                None,
            ))
            state = FakeState()

            handle_scan(backend, state, ob, "9")

            self.assertEqual(ob.pending_count(), 0)
            self.assertIn("banner-ok", state.events[-1]["html"])

    def test_live_scan_is_not_sent_as_a_replay(self):
        # A live kiosk scan must reach the server unflagged, or the server
        # parks the force-close instead of warning at the door.
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            backend = self._backend(({"type": "checkin", "participant": {}}, 200, None))

            handle_scan(backend, FakeState(), ob, "9")

            self.assertNotIn("replay", backend.post_scan.call_args.kwargs)

    def test_dead_letter_response_is_not_queued(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            backend = self._backend(({"error": "unknown participant"}, 404, None))
            state = FakeState()

            handle_scan(backend, state, ob, "9")

            self.assertEqual(ob.pending_count(), 0)
            self.assertIn("banner-error", state.events[-1]["html"])

    def test_second_scan_for_same_pending_participant_enqueues_behind_first(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            backend = self._backend(({"error": "down"}, 0, None))
            state = FakeState()

            handle_scan(backend, state, ob, "9")  # queues evt-1
            handle_scan(backend, state, ob, "9")  # must not attempt live delivery

            self.assertEqual(ob.pending_count(), 2)
            self.assertEqual(backend.post_scan.call_count, 1)
            self.assertIn("2 waiting", state.events[-1]["html"])
            self.assertEqual(state.events[-1]["queued"], 2)

    def test_enqueue_pushes_queued_count_for_the_badge_not_just_on_drain(self):
        with tempfile.TemporaryDirectory() as d:
            ob = Outbox(os.path.join(d, "outbox.db"))
            backend = self._backend(({"error": "Connection refused"}, 0, None))
            state = FakeState()

            handle_scan(backend, state, ob, "9")

            self.assertEqual(state.events[-1]["queued"], 1)


class TestSavedBanner(unittest.TestCase):
    def test_banner_text_includes_queue_count(self):
        self.assertIn("3 waiting", _saved_banner_html(3))
        self.assertIn("banner-saved", _saved_banner_html(0))


if __name__ == "__main__":
    unittest.main()
