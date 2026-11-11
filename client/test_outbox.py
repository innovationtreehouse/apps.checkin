"""Tests for the offline scan queue: durability across restart, ordered
replay, no-double-submit under the idempotency rules, and the queued/offline
banner (#1257)."""

import os
import tempfile
import threading
import unittest
from unittest.mock import MagicMock

from outbox import (Outbox, classify_response, replay_drain, new_event_id, now_iso,
                    in_closed_window, MIN_BACKOFF_SECONDS, DRAIN_PACE_SECONDS)
from client import handle_scan, _saved_banner_html, ClockWatch, SCAN_PROTOCOL_VERSION


class _StopLoop(Exception):
    """Sentinel to escape replay_drain's `while True` in tests."""


class FakeState:
    def __init__(self):
        self.events = []
        self.clock_watch = ClockWatch()
        self.present_ids = set()
        self.scan_protocol = SCAN_PROTOCOL_VERSION
        self.known_people = {}
        self.save_lock = threading.Lock()

    def saved_view(self):
        return None

    def push_event(self, data):
        self.events.append(data)

    def displayed_intent(self, participant_id):
        return "IN"

    def note_presence(self, participant_id, checking_in, is_keyholder=None):
        return

    def seed_from_attendance(self, att_data, pending=()):
        return

    def take_local_close(self, participant_id):
        return False

    def arm_local_close(self, participant_id, seconds):
        return

    def is_repeat_read(self, participant_id):
        return False

    def close_decision(self, participant_id):
        return None, []

    def clear_present(self):
        self.present_ids = set()

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

    def test_a_row_an_older_client_dead_lettered_replays_after_upgrade(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "outbox.db")
            ob = Outbox(path)
            ob.enqueue("evt-1", "1", now_iso())
            ob._conn.execute("UPDATE outbox SET state='dead'")
            ob._conn.commit()
            ob._conn.close()

            self.assertEqual([r[0] for r in Outbox(path).pending_rows()], ["evt-1"])


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

    def test_refusals_retry(self):
        # The drain's server parks a replay it cannot apply; a refusal is
        # never a reason to drop the scan.
        for status in (400, 403, 404, 409, 418):
            self.assertEqual(classify_response(status, {"error": "nope"}), "retry")

    def test_retry_cases(self):
        for status, body in [
            (0, {"error": "timeout"}),
            (503, {}),
            (429, {}),
            (401, {}),
            (500, {}),
            (502, {}),
            (400, {"type": "warming"}),
            (200, {"type": "warming"}),  # a captive portal's 200 HTML, normalized by post_scan
        ]:
            self.assertEqual(classify_response(status, body), "retry", (status, body))

    def test_warming_sentinel_wins_regardless_of_status(self):
        # post_scan normalizes any non-JSON body (waker HTML, a captive
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

            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep)
            return ob

    def test_a_426_version_bounce_is_a_retry(self):
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
                             protocol_ok_fn=lambda: False)
            # Nothing sent, nothing lost: the row is held, not dropped.
            self.assertEqual(sent, [])
            self.assertEqual(len(ob.pending_rows()), 1)

            # Server upgrades mid-run: the same drain resumes and delivers.
            ticks["n"] = -10
            with self.assertRaises(_StopLoop):
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep,
                             protocol_ok_fn=lambda: True)
            self.assertEqual(len(sent), 1)
            self.assertEqual(ob.pending_rows(), [])

    def test_acked_events_are_removed_in_order(self):
        ob = self._run([
            ({"type": "checkin"}, 200, None),
            ({"type": "checkout"}, 200, None),
        ])
        self.assertEqual(ob.pending_rows(), [])

    def test_a_refused_replay_stays_at_the_head(self):
        ob = self._run([
            ({"error": "unknown participant"}, 404, None),
        ])
        self.assertEqual(len(ob.pending_rows()), 1)

    def test_retry_keeps_the_event_pending(self):
        ob = self._run([
            ({}, 503, "30"),
        ])
        self.assertEqual(len(ob.pending_rows()), 1)
        self.assertEqual(ob.pending_rows()[0][3], 1)  # attempts bumped

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
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep)

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
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep)

            self.assertEqual(seen, [True])

    def test_drain_replays_the_stored_force_close_token(self):
        # A confirm the keyholder gave before the outage still
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
                replay_drain(ob, send_fn, push_fn=None, sleep_fn=fake_sleep)

            self.assertEqual(seen, [("evt-tok", "tok-1"), ("evt-none", None)])


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

    def test_a_live_refusal_is_shown_and_not_queued(self):
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

    def test_malformed_scan_is_rejected_without_sending_or_queueing(self):
        # Concatenated double-read, UPC, and over-int4 ids never reach the outbox.
        for raw in ("12345123451", "012345678905", "2147483648", "0", "12a"):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as d:
                ob = Outbox(os.path.join(d, "outbox.db"))
                backend = self._backend(({"error": "down"}, 0, None))
                state = FakeState()

                handle_scan(backend, state, ob, raw)

                self.assertEqual(backend.post_scan.call_count, 0)
                self.assertEqual(ob.pending_count(), 0)
                self.assertIn("banner-error", state.events[-1]["html"])

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


class _Killed(BaseException):
    """Stands in for os._exit landing mid-POST: nothing after it runs."""


class TestEnqueueBeforeSend(unittest.TestCase):
    """The scan is durable before the live POST, so a restart (self-update,
    health monitor) during the send cannot lose it."""

    CHECKIN = ({"type": "checkin", "participant": {}}, 200, None)

    def _drain_once(self, ob, send_fn):
        def stop(_secs):
            raise _StopLoop()
        with self.assertRaises(_StopLoop):
            replay_drain(ob, send_fn, sleep_fn=stop)

    def test_a_kill_during_the_live_post_leaves_the_row_and_the_drain_delivers_it_once(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "outbox.db")
            backend = MagicMock(attendance_path=None)
            backend.post_scan.side_effect = _Killed()
            with self.assertRaises(_Killed):
                handle_scan(backend, FakeState(), Outbox(path), "9")
            live_id = backend.post_scan.call_args.kwargs["client_event_id"]

            ob = Outbox(path)  # restart
            rows = ob.pending_rows(skip_inflight=True)
            self.assertEqual([r[0] for r in rows], [live_id])
            self.assertEqual(rows[0][5], "IN")

            sent = []

            def send_fn(pid, **kw):
                sent.append(kw["client_event_id"])
                return self.CHECKIN

            self._drain_once(ob, send_fn)
            self._drain_once(ob, send_fn)
            self.assertEqual(sent, [live_id])
            self.assertEqual(ob.pending_rows(), [])

    def test_an_acked_live_scan_deletes_its_row(self):
        ob = Outbox(":memory:")
        backend = MagicMock(attendance_path=None)
        backend.post_scan.return_value = self.CHECKIN
        handle_scan(backend, FakeState(), ob, "9")
        self.assertEqual(ob.pending_rows(), [])

    def test_a_refused_live_scan_deletes_its_row(self):
        # Shown as an error at the door, never replayed -- as before.
        ob = Outbox(":memory:")
        backend = MagicMock(attendance_path=None)
        backend.post_scan.return_value = ({"error": "unknown participant"}, 404, None)
        handle_scan(backend, FakeState(), ob, "9")
        self.assertEqual(ob.pending_rows(), [])

    def test_a_retry_keeps_the_row_pending_for_the_drain(self):
        ob = Outbox(":memory:")
        backend = MagicMock(attendance_path=None)
        backend.post_scan.return_value = ({"error": "down"}, 0, None)
        handle_scan(backend, FakeState(), ob, "9")
        rows = ob.pending_rows(skip_inflight=True)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], backend.post_scan.call_args.kwargs["client_event_id"])

    def test_the_drain_never_sends_a_row_the_live_post_is_sending(self):
        ob = Outbox(":memory:")
        drained, seen = [], {}

        def drain_send(pid, **kw):
            drained.append(kw["client_event_id"])
            return self.CHECKIN

        def live_post(pid, **kw):
            # The drain runs while the live POST is in flight.
            seen["overlay"] = [r[0] for r in ob.pending_rows()]
            seen["count"] = ob.pending_count()
            self._drain_once(ob, drain_send)
            return self.CHECKIN

        backend = MagicMock(attendance_path=None)
        backend.post_scan.side_effect = live_post
        handle_scan(backend, FakeState(), ob, "9")

        live_id = backend.post_scan.call_args.kwargs["client_event_id"]
        self.assertEqual(drained, [])
        self.assertEqual(seen["overlay"], [live_id], "presence overlay still sees the in-flight scan")
        self.assertEqual(seen["count"], 0, "the queued badge does not count the in-flight scan")
        self.assertEqual(ob.pending_rows(), [])

    def test_the_claim_holds_until_the_ack_deletes_the_row(self):
        # A drain tick landing after the 2xx but before the delete must not resend.
        ob = Outbox(":memory:")
        drained = []

        def drain_send(pid, **kw):
            drained.append(kw["client_event_id"])
            return self.CHECKIN

        real_ack = ob.ack

        def ack_after_a_drain_tick(event_id):
            ob.ack = real_ack
            self._drain_once(ob, drain_send)
            real_ack(event_id)

        ob.ack = ack_after_a_drain_tick
        backend = MagicMock(attendance_path=None)
        backend.post_scan.return_value = self.CHECKIN
        handle_scan(backend, FakeState(), ob, "9")

        self.assertEqual(drained, [])
        self.assertEqual(ob.pending_rows(), [])

    def test_own_row_is_not_its_predecessor(self):
        ob = Outbox(":memory:")
        backend = MagicMock(attendance_path=None)
        backend.post_scan.return_value = self.CHECKIN
        handle_scan(backend, FakeState(), ob, "9")
        backend.post_scan.assert_called_once()


if __name__ == "__main__":
    unittest.main()
