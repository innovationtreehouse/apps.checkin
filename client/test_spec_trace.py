"""Scripted kiosk scenarios for trace validation. Each drives the real
handle_scan and AttendanceState against a scripted server, asserts what the
kiosk did, and leaves one NDJSON trace per scenario in KIOSK_TRACE_DIR (a temp
dir when unset). The first line is the scenario's topology."""

import glob
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import client
import spec_trace
from client import AttendanceState, handle_scan

K1, M1, U1 = 9, 5, 4242
NAMES = {K1: "k1", M1: "m1", U1: "u1"}
KEYHOLDERS = {K1}


class ScriptedServer:
    """Answers each POST from a script and serves the roster the test sets."""

    def __init__(self, inside):
        self.attendance_path = "/api/attendance"
        self.inside = set(inside)
        self.script = []
        self.sent = []

    def answer(self, body, status=200):
        self.script.append((body, status))

    def post_scan(self, participant_id):
        self.sent.append(int(participant_id))
        return self.script.pop(0)

    def get_attendance(self):
        return {
            "attendance": [{"participant": {"id": p, "name": NAMES[p], "isKeyholder": p in KEYHOLDERS}}
                           for p in sorted(self.inside)],
            "counts": {"total": len(self.inside)},
        }, 200


OFFLINE = ({"error": "Connection refused"}, 0)


def checkout(pid, closed=None):
    body = {"type": "checkout", "participant": {"id": pid, "name": NAMES[pid]}}
    if closed is not None:
        body["facilityClosed"] = closed
    return body


def checkin(pid):
    return {"type": "checkin", "participant": {"id": pid, "name": NAMES[pid]}}


class TestSpecTraceScenarios(unittest.TestCase):
    trace_dir = os.environ.get("KIOSK_TRACE_DIR") or tempfile.mkdtemp(prefix="kiosk-traces-")

    def setUp(self):
        os.makedirs(self.trace_dir, exist_ok=True)
        # A distinct scan of the same badge, with no wait for the reader's filter.
        patcher = patch.object(client, "REPEAT_READ_SECONDS", 0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        spec_trace.start(None)

    def begin(self, scenario, inside):
        server = ScriptedServer(inside)
        state = AttendanceState()
        state.push_event = lambda event: None
        self.file = os.path.join(self.trace_dir, f"{scenario}.ndjson")
        with open(self.file, "w") as f:
            f.write(json.dumps({"tag": "config", "config": {
                "scenario": scenario,
                "persons": {str(p): n for p, n in NAMES.items()},
                "keyholders": ["k1"],
                "inside": [NAMES[p] for p in sorted(inside)],
                "unresolvable": ["u1"],
            }}) + "\n")
        spec_trace.start(self.file)
        return server, state

    def events(self):
        with open(self.file) as f:
            return [json.loads(l)["event"]["name"] for l in f if json.loads(l)["tag"] == "trace"]

    def test_check_in_then_out(self):
        server, state = self.begin("kiosk_in_then_out", set())
        server.answer(checkin(M1))
        server.inside = {M1}
        handle_scan(server, state, M1)
        server.answer(checkout(M1))
        server.inside = set()
        handle_scan(server, state, M1)
        self.assertEqual(server.sent, [M1, M1])
        self.assertEqual(self.events().count("KioskScanResult"), 2)

    def test_the_server_closes_the_building(self):
        server, state = self.begin("kiosk_server_close", {K1})
        server.answer(checkout(K1, closed=True))
        server.inside = set()
        handle_scan(server, state, K1)
        self.assertEqual(state.current_counts, {"total": 0})
        self.assertEqual(self.events(), ["KioskBadge", "KioskScanResult"])

    def test_an_unreachable_server_records_the_attempt_and_nothing_else(self):
        server, state = self.begin("kiosk_offline_scan", {K1})
        server.answer(*OFFLINE)
        handle_scan(server, state, M1)
        self.assertEqual(server.sent, [M1])
        self.assertEqual(self.events(), ["KioskBadge", "KioskScanResult"])

    def test_an_unresolvable_badge_is_refused_by_the_server(self):
        server, state = self.begin("kiosk_unresolvable_badge", {K1})
        server.answer({"error": f"Participant {U1} not found."}, 404)
        handle_scan(server, state, U1)
        self.assertEqual(server.sent, [U1])
        self.assertEqual(self.events(), ["KioskBadge", "KioskScanResult"])


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
