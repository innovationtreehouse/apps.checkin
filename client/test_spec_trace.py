"""Scripted kiosk scenarios for trace validation of the check-in TLA+ model
(CheckinImpl_v3). Each drives the real handle_scan, AttendanceState, Outbox
and replay_drain against a scripted server, asserts what the kiosk did, and
leaves one NDJSON trace per scenario in KIOSK_TRACE_DIR (a temp dir when
unset). The first line is the scenario's topology."""

import glob
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import client
import spec_trace
from client import AttendanceState, SCAN_PROTOCOL_VERSION, handle_scan
from outbox import Outbox, replay_drain

K1, K2, M1, U1 = 9, 8, 5, 4242
NAMES = {K1: "k1", K2: "k2", M1: "m1", U1: "u1"}
KEYHOLDERS = {K1, K2}


class _Drained(Exception):
    pass


class ScriptedServer:
    """Answers each POST from a script and serves the roster the test sets."""

    def __init__(self, inside):
        self.attendance_path = "/api/attendance"
        self.inside = set(inside)
        self.script = []
        self.sent = []

    def answer(self, body, status=200):
        self.script.append((body, status))

    def post_scan(self, participant_id, **kw):
        self.sent.append((int(participant_id), kw))
        body, status = self.script.pop(0)
        return body, status, None

    def get_attendance(self):
        return {
            "attendance": [{"participant": {"id": p, "name": NAMES[p], "isKeyholder": p in KEYHOLDERS}}
                           for p in sorted(self.inside)],
            "counts": {"total": len(self.inside)},
            "rosterAsOf": client.now_iso(),
        }, 200


OFFLINE = ({"error": "Connection refused"}, 0)


def checkout(pid, closed=None, prompt=None):
    body = {"type": "checkout", "participant": {"id": pid, "name": NAMES[pid]}}
    if closed is not None:
        body["facilityClosed"] = closed
    if prompt:
        body["closePrompt"] = prompt
    return body


def checkin(pid):
    return {"type": "checkin", "participant": {"id": pid, "name": NAMES[pid]}}


class TestSpecTraceScenarios(unittest.TestCase):
    trace_dir = os.environ.get("KIOSK_TRACE_DIR") or tempfile.mkdtemp(prefix="kiosk-traces-")

    def setUp(self):
        os.makedirs(self.trace_dir, exist_ok=True)
        self._tmp = tempfile.TemporaryDirectory()
        self.outbox = Outbox(os.path.join(self._tmp.name, "outbox.db"))
        # A distinct scan of the same badge, with no wait for the reader's filter.
        patcher = patch.object(client, "REPEAT_READ_SECONDS", 0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        spec_trace.start(None)
        self._tmp.cleanup()

    def begin(self, scenario, inside):
        server = ScriptedServer(inside)
        state = AttendanceState()
        state.scan_protocol = SCAN_PROTOCOL_VERSION
        state.push_event = lambda event: None
        state.seed_from_attendance(server.get_attendance()[0])
        self.file = os.path.join(self.trace_dir, f"{scenario}.ndjson")
        with open(self.file, "w") as f:
            f.write(json.dumps({"tag": "config", "config": {
                "scenario": scenario,
                "persons": {str(p): n for p, n in NAMES.items()},
                "keyholders": ["k1", "k2"],
                "inside": [NAMES[p] for p in sorted(inside)],
                "unresolvable": ["u1"],
            }}) + "\n")
        spec_trace.start(self.file)
        return server, state

    def drain(self, server):
        def stop_when_empty(_seconds):
            if not self.outbox.pending_rows(skip_inflight=True):
                raise _Drained()
        with self.assertRaises(_Drained):
            replay_drain(self.outbox, server.post_scan, sleep_fn=stop_when_empty)

    def events(self):
        with open(self.file) as f:
            return [json.loads(l)["event"]["name"] for l in f if json.loads(l)["tag"] == "trace"]

    def test_single_keyholder_close(self):
        server, state = self.begin("kiosk_single_keyholder_close", {K1, M1})
        server.answer(checkout(K1))
        server.inside = {M1}
        handle_scan(server, state, self.outbox, K1)
        self.assertIsNone(server.sent[-1][1]["close"], "others shown: the first scan only leaves")
        server.answer(checkout(K1, closed=True))
        server.inside = set()
        handle_scan(server, state, self.outbox, K1)
        self.assertEqual(server.sent[-1][1]["close"], "confirmed")
        self.assertEqual(state.present_ids, set())
        self.assertEqual(self.events().count("KioskLiveResult"), 2)

    def test_two_keyholders(self):
        server, state = self.begin("kiosk_two_keyholders", {K1, K2})
        server.answer(checkout(K1))
        server.inside = {K2}
        handle_scan(server, state, self.outbox, K1)
        self.assertIsNone(server.sent[-1][1]["close"])
        server.answer(checkout(K2, closed=True))
        server.inside = set()
        handle_scan(server, state, self.outbox, K2)
        self.assertEqual(server.sent[-1][1]["close"], "alone", "another badge ends k1's prompt")

    def test_held_close_with_a_lost_reply(self):
        server, state = self.begin("kiosk_held_close_lost_reply", {K1})
        server.answer(*OFFLINE)
        handle_scan(server, state, self.outbox, K1)
        self.assertEqual(server.sent[-1][1]["close"], "alone")
        self.assertEqual(len(self.outbox.pending_rows()), 1, "an unanswered close stays for the drain")
        server.answer(checkout(K1, closed=True))
        server.inside = set()
        self.drain(server)
        self.assertTrue(server.sent[-1][1]["replay"])
        self.assertEqual(self.outbox.pending_rows(), [])
        self.assertEqual(self.events()[-2:], ["DrainSend", "DrainResult"])

    def test_queued_in_racing_a_live_close(self):
        server, state = self.begin("kiosk_queued_in_races_close", {K1})
        server.answer(*OFFLINE)
        handle_scan(server, state, self.outbox, M1)
        server.answer(checkout(K1))
        server.inside = set()
        handle_scan(server, state, self.outbox, K1)
        self.assertIsNone(server.sent[-1][1]["close"], "the queued IN shows m1 inside")
        self.assertEqual(state.present_ids, {M1})
        server.answer(checkout(K1, closed=True))
        handle_scan(server, state, self.outbox, K1)
        self.assertEqual(server.sent[-1][1]["close"], "confirmed")
        server.answer(checkin(M1))
        self.drain(server)
        self.assertEqual(server.sent[-1][0], M1)
        self.assertEqual(self.outbox.pending_rows(), [])

    def test_offline_replay_after_a_close(self):
        server, state = self.begin("kiosk_offline_replay_after_close", {K1, M1})
        server.answer(*OFFLINE)
        handle_scan(server, state, self.outbox, M1)
        server.answer(*OFFLINE)
        handle_scan(server, state, self.outbox, K1)
        rows = self.outbox.pending_rows()
        self.assertEqual([(r.participant_id, r.intent, r.close) for r in rows],
                         [(str(M1), "OUT", None), (str(K1), "OUT", "alone")])
        server.answer(checkout(M1))
        server.answer(checkout(K1, closed=True))
        server.inside = set()
        self.drain(server)
        self.assertEqual([s[0] for s in server.sent[-2:]], [M1, K1])
        self.assertEqual(self.events().count("DrainResult"), 2)

    def test_parked_replay(self):
        server, state = self.begin("kiosk_parked_replay", {K1})
        server.answer({"error": f"Participant {U1} not found."}, 404)
        handle_scan(server, state, self.outbox, U1)
        self.assertEqual(self.outbox.pending_rows(), [], "a live refusal is settled, not queued")
        server.answer(*OFFLINE)
        handle_scan(server, state, self.outbox, U1)
        server.answer({"type": "parked"})
        self.drain(server)
        self.assertEqual(self.outbox.pending_rows(), [], "a parked replay is acked")


class TestSpecTraceIsAbsentInProduction(unittest.TestCase):
    def test_nothing_is_recorded_unless_a_test_starts_it(self):
        self.assertIsNone(spec_trace._sink)
        with tempfile.TemporaryDirectory() as d:
            spec_trace.emit("KioskBadge", p="9")
            self.assertEqual(os.listdir(d), [])

    def test_no_kiosk_module_starts_it(self):
        here = os.path.dirname(os.path.abspath(__file__))
        for path in glob.glob(os.path.join(here, "*.py")):
            if os.path.basename(path).startswith("test_"):
                continue
            with open(path) as f:
                self.assertNotIn("spec_trace.start(", f.read(), path)


if __name__ == "__main__":
    unittest.main()
