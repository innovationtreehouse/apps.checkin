"""The kiosk's saved view: a restart keeps who is inside, the snapshot and queue
row commit together, a restored view never reads as known empty, and older code
runs against a newer file. A restart here is new objects on the same file, with
no clean shutdown of the old ones."""

import json
import os
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from client import AttendanceState, TWO_DEEP_CLOSE_WARNING, building_known_empty, handle_scan
from outbox import Outbox, PendingRow, now_iso

KEYHOLDER, MEMBER, NEWCOMER = 9, 5, 7
ROSTER = {
    "access": "full",
    "counts": {"total": 2, "keyholders": 1, "volunteers": 1, "youth": 0},
    "attendance": [
        {"id": 1, "arrivedAt": "2026-10-31T17:00:00Z", "participant": {"id": KEYHOLDER, "name": "Kim", "isKeyholder": True}},
        {"id": 2, "arrivedAt": "2026-10-31T17:05:00Z", "participant": {"id": MEMBER, "name": "Sam", "isKeyholder": False}},
    ],
    "safety": {"isTwoDeepViolation": True},
    "rosterAsOf": "2026-10-31T18:00:00Z",
}
EMPTY_ROSTER = {"access": "full", "counts": {"total": 0}, "attendance": [], "safety": {}}


def offline_backend():
    backend = MagicMock()
    backend.post_scan.return_value = ({"type": "warming"}, 503, None)
    backend.attendance_path = None
    return backend


class SavedViewCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "outbox.db")

    def start(self):
        outbox = Outbox(self.path)
        state = AttendanceState()
        state.restore_from(outbox)
        return state, outbox

    def started_with_roster(self, roster=ROSTER):
        state, outbox = self.start()
        state.seed_from_attendance(roster, outbox.pending_rows())
        return state, outbox

    def saved(self):
        conn = sqlite3.connect(self.path)
        try:
            return conn.execute("SELECT snapshot FROM kiosk_snapshot").fetchall()
        finally:
            conn.close()

    def banners(self, state):
        q = state.subscribe()
        return lambda: [q.get_nowait()["html"] for _ in range(q.qsize())]


class TestRestart(SavedViewCase):
    def test_person_inside_still_badges_out(self):
        self.started_with_roster()
        state, outbox = self.start()
        handle_scan(offline_backend(), state, outbox, MEMBER)
        self.assertEqual(outbox.pending_rows()[0].intent, "OUT")

    def test_keyholder_leaving_with_others_inside_gets_the_close(self):
        self.started_with_roster()
        state, outbox = self.start()
        read = self.banners(state)
        handle_scan(offline_backend(), state, outbox, KEYHOLDER)
        self.assertEqual(outbox.pending_rows()[0].close, None)
        banner = read()[0]
        self.assertIn("Sam", banner, "the prompt names who the saved roster shows inside")
        self.assertIn(TWO_DEEP_CLOSE_WARNING, banner, "the two-deep caution survives")
        self.assertEqual(state.local_close_participant, KEYHOLDER)

    def test_last_keyholder_inside_closes_with_one_badge(self):
        state, outbox = self.started_with_roster()
        handle_scan(offline_backend(), state, outbox, MEMBER)
        state, outbox = self.start()
        handle_scan(offline_backend(), state, outbox, KEYHOLDER)
        self.assertEqual(outbox.pending_rows()[-1].close, "alone")
        self.assertEqual(outbox.pending_rows()[-1].roster_as_of, ROSTER["rosterAsOf"])

    def test_screen_shows_the_saved_roster_marked_not_fresh(self):
        self.started_with_roster()
        state, _ = self.start()
        view = state.attendance_view()
        self.assertEqual({v["participant"]["name"] for v in view["attendance"]}, {"Kim", "Sam"})
        self.assertIsNotNone(view["kioskAsOf"])

    def test_badge_since_the_roster_keeps_its_name_and_arrival(self):
        state, outbox = self.started_with_roster()
        state.known_people[NEWCOMER] = {"id": NEWCOMER, "name": "Ana"}
        handle_scan(offline_backend(), state, outbox, NEWCOMER)
        arrived = state.local_arrivals[NEWCOMER]
        outbox.ack(outbox.pending_rows()[0].client_event_id)
        state, _ = self.start()
        shown = {v["participant"]["id"]: v for v in state.attendance_view()["attendance"]}
        self.assertEqual(shown[NEWCOMER]["participant"]["name"], "Ana")
        self.assertEqual(shown[NEWCOMER]["arrivedAt"], arrived)

    def test_pending_scans_overlay_the_saved_view(self):
        _, outbox = self.started_with_roster()
        outbox.enqueue("e1", MEMBER, now_iso(), intent="OUT")
        outbox.enqueue("e2", NEWCOMER, now_iso(), intent="IN")
        state, _ = self.start()
        self.assertEqual(state.present_ids, {KEYHOLDER, NEWCOMER})

    def test_first_good_roster_replaces_the_saved_view(self):
        self.started_with_roster()
        state, outbox = self.started_with_roster(EMPTY_ROSTER)
        self.assertEqual(state.present_ids, set())
        self.assertFalse(state.last_two_deep_violation)
        state, _ = self.start()
        self.assertEqual(state.present_ids, set())

    def test_unknown_version_is_ignored(self):
        _, outbox = self.started_with_roster()
        outbox.save_snapshot(json.dumps({"version": 2, "presentIds": [MEMBER]}))
        state, _ = self.start()
        self.assertEqual(state.present_ids, set())
        self.assertEqual(state.displayed_intent(MEMBER), "IN")
        self.assertIsNone(state.last_roster_body)

    def test_unreadable_snapshot_is_ignored(self):
        _, outbox = self.started_with_roster()
        for bad in ("not json", "[]", '{"version": 1}', '{"version": 1, "presentIds": ["x"]}'):
            outbox.save_snapshot(bad)
            state, _ = self.start()
            self.assertEqual(state.present_ids, set())

    def test_new_keys_need_no_new_version(self):
        _, outbox = self.started_with_roster()
        view = json.loads(outbox.load_snapshot())
        view["clearedThroughQueueId"] = 12
        outbox.save_snapshot(json.dumps(view))
        state, _ = self.start()
        self.assertEqual(state.present_ids, {KEYHOLDER, MEMBER})


class TestAtomicWrite(SavedViewCase):
    def test_failed_queue_row_rolls_back_the_snapshot(self):
        _, outbox = self.started_with_roster()
        before = outbox.load_snapshot()
        with self.assertRaises(sqlite3.Error):
            # An unbindable value fails the insert, after the snapshot's write.
            outbox.enqueue("e1", MEMBER, object(), intent="OUT", inflight=True, snapshot="{}")
        reopened = Outbox(self.path)
        self.assertEqual(reopened.load_snapshot(), before)
        self.assertEqual(reopened.pending_rows(), [])
        self.assertNotIn("e1", outbox._inflight)

    def test_failed_snapshot_keeps_the_queue_row_out(self):
        _, outbox = self.started_with_roster()
        before = outbox.load_snapshot()
        with self.assertRaises(sqlite3.Error):
            outbox.enqueue("e1", MEMBER, now_iso(), intent="OUT", snapshot=object())
        reopened = Outbox(self.path)
        self.assertEqual(reopened.load_snapshot(), before)
        self.assertEqual(reopened.pending_rows(), [])

    def test_a_badge_saves_its_own_result_with_its_row(self):
        state, outbox = self.started_with_roster()
        handle_scan(offline_backend(), state, outbox, MEMBER)
        self.assertNotIn(MEMBER, json.loads(outbox.load_snapshot())["presentIds"])
        self.assertEqual(len(self.saved()), 1, "one row, however many writes")


class TestWritesOnlyOnChange(SavedViewCase):
    def test_refetching_the_same_roster_writes_nothing(self):
        state, outbox = self.started_with_roster()
        later = dict(ROSTER, rosterAsOf="2026-10-31T18:00:30Z",
                     building={"reachable": True, "lastSeenAt": "2026-10-31T18:00:30Z", "queued": 0})
        with patch.object(outbox, "save_snapshot") as save:
            self.assertTrue(state.seed_from_attendance(later))
        save.assert_not_called()

    def test_a_changed_roster_writes(self):
        state, outbox = self.started_with_roster()
        with patch.object(outbox, "save_snapshot") as save:
            state.seed_from_attendance(EMPTY_ROSTER)
        save.assert_called_once()

    def test_start_and_identical_roster_write_nothing(self):
        self.started_with_roster()
        outbox = Outbox(self.path)
        state = AttendanceState()
        with patch.object(outbox, "save_snapshot") as save:
            state.restore_from(outbox)
            state.seed_from_attendance(ROSTER)
        save.assert_not_called()

    def test_failed_save_does_not_stop_a_roster(self):
        state, outbox = self.started_with_roster()
        before = outbox.load_snapshot()
        outbox._conn.execute(
            "CREATE TRIGGER refuse BEFORE INSERT ON kiosk_snapshot BEGIN SELECT RAISE(ABORT, 'disk full'); END"
        )
        self.assertTrue(state.seed_from_attendance(EMPTY_ROSTER))
        self.assertEqual(state.present_ids, set())
        self.assertEqual(outbox.load_snapshot(), before)


class TestEmptyNeverInvented(SavedViewCase):
    def test_restored_empty_does_not_rest_until_a_real_roster(self):
        self.started_with_roster(EMPTY_ROSTER)
        state, _ = self.start()
        self.assertEqual(state.present_ids, set())
        self.assertFalse(state.counts_known)
        self.assertFalse(building_known_empty(state))
        state.seed_from_attendance(EMPTY_ROSTER)
        self.assertTrue(building_known_empty(state))


class TestFilePermissions(SavedViewCase):
    def mode(self, path):
        return stat.S_IMODE(os.stat(path).st_mode)

    def test_new_file_and_its_wal_are_owner_only(self):
        state, outbox = self.started_with_roster()
        handle_scan(offline_backend(), state, outbox, MEMBER)
        self.assertEqual(self.mode(self.path), 0o600)
        self.assertEqual(self.mode(self.path + "-wal"), 0o600)

    def test_existing_readable_file_is_tightened(self):
        Outbox(self.path)._conn.close()
        os.chmod(self.path, 0o644)
        Outbox(self.path)
        self.assertEqual(self.mode(self.path), 0o600)

    def test_failed_chmod_logs_and_scanning_continues(self):
        with patch("outbox.os.chmod", side_effect=PermissionError("denied")):
            with self.assertLogs("kiosk", level="ERROR") as logs:
                outbox = Outbox(self.path)
        self.assertIn(f"ERROR:kiosk:Could not restrict {self.path}: denied", logs.output)
        outbox.enqueue("after-failed-chmod", MEMBER, now_iso(), intent="IN")
        self.assertEqual(outbox.pending_count(), 1)


class TestOlderCodeAgainstNewerFile(SavedViewCase):
    """The statements the previous image runs, frozen here as that image's contract."""

    def older_outbox(self):
        conn = sqlite3.connect(self.path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(Outbox._SCHEMA_SQL)
        return conn

    def test_older_code_queues_reads_and_acks(self):
        _, outbox = self.started_with_roster()
        outbox.enqueue("newer", MEMBER, "2026-10-31T18:00:00Z", intent="OUT", snapshot=outbox.load_snapshot())
        conn = self.older_outbox()
        conn.execute(
            "INSERT OR IGNORE INTO outbox "
            "(client_event_id, participant_id, scanned_at, created_at, force_close_token, "
            " intent, clock_suspect, force_close_confirmed, close, roster_as_of, shown_empty) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("older", "7", "2026-10-31T18:01:00Z", now_iso(), None, "IN", 0, 0, None, None, None),
        )
        conn.commit()
        rows = conn.execute(
            f"SELECT {', '.join(PendingRow._fields)} FROM outbox WHERE state='pending' ORDER BY scanned_at ASC"
        ).fetchall()
        self.assertEqual([PendingRow(*r).client_event_id for r in rows], ["newer", "older"])
        conn.execute("DELETE FROM outbox WHERE client_event_id='newer'")
        conn.commit()
        conn.close()
        self.assertEqual([r.client_event_id for r in Outbox(self.path).pending_rows()], ["older"])

    def test_snapshot_lives_outside_the_queue_table(self):
        self.started_with_roster()
        conn = sqlite3.connect(self.path)
        columns = {r[1] for r in conn.execute("PRAGMA table_info(outbox)")}
        self.assertEqual(columns, set(PendingRow._fields) | {"last_status", "state", "created_at"})
        self.assertEqual(
            {r[1]: r[3] for r in conn.execute("PRAGMA table_info(kiosk_snapshot)")},
            {"id": 0, "snapshot": 0},
            "additive and nullable",
        )
        conn.close()

    def test_file_with_no_snapshot_table_gains_one(self):
        self.older_outbox().close()
        state, outbox = self.start()
        self.assertIsNone(outbox.load_snapshot())
        self.assertEqual(state.present_ids, set())
        self.assertFalse(state.counts_known)


if __name__ == "__main__":
    unittest.main()
