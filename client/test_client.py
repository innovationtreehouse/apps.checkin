import inspect
import io
import json
import os
import re
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, Mock, patch

from nacl.signing import SigningKey

from client import (
    AttendanceState,
    RELEASE_CHANNEL_MARKER,
    RELEASE_TAG_GLOB,
    BackendClient,
    DEFAULT_KIOSK_PATH,
    CLOSING_ALONE_COPY,
    FORCE_CLOSE_CONFIRM_SECONDS,
    SCAN_PROTOCOL_VERSION,
    UNKNOWN_PERSON_NAME,
    KioskHandler,
    _saved_banner_html,
    _scan_result_banner_html,
    attendance_poller,
    handle_scan,
    KioskHandler,
    local_clock_label,
    latest_release_tag,
    main,
    resolve_update_target,
    building_known_empty,
    skip_roster_get,
)
from outbox import Outbox, in_closed_window


class _StopLoop(Exception):
    """Sentinel to escape attendance_poller's `while True` in tests."""


def scan_banner(body, status=200):
    # handle_scan now takes an outbox and delegates the markup to this helper;
    # calling it directly tests the same banner without faking a backend.
    return _scan_result_banner_html(body, status)[0]


class TestLocalClockReadout(unittest.TestCase):
    """The door screen shows the Pi's clock as Python sees it, so a Pi on the
    wrong timezone (which shifts in_closed_window) is visible at a glance."""

    CDT = timezone(timedelta(hours=-5), "CDT")

    def test_label_carries_time_zone_name_and_offset(self):
        self.assertEqual(local_clock_label(datetime(2026, 10, 7, 14, 5, tzinfo=self.CDT)),
                         "14:05 CDT (UTC-0500)")

    def test_label_flags_the_closed_window(self):
        self.assertTrue(local_clock_label(datetime(2026, 10, 7, 23, 30, tzinfo=self.CDT))
                        .endswith("overnight"))

    def test_wrapper_renders_the_clock_fed_by_the_sse_stream(self):
        wrapper = inspect.getsource(KioskHandler._serve_wrapper)
        self.assertIn('id="local-clock"', wrapper)
        self.assertIn('addEventListener("clock"', wrapper)
        self.assertIn("event: clock", inspect.getsource(KioskHandler._serve_sse))

    def test_wrapper_posts_the_roster_only_to_its_own_origin(self):
        wrapper = inspect.getsource(KioskHandler._serve_wrapper)
        posts = re.findall(r"postMessage\(.*\);", wrapper)
        self.assertEqual(len(posts), 2)
        for post in posts:
            self.assertTrue(post.endswith(", window.location.origin);"), post)


class TestScanBannerName(unittest.TestCase):
    """The banner names whoever scanned by the name they go by. It is an
    unattended public screen, so it must never read out an email address
    (checkin docs/rules/attendance-checkin.md, "The kiosk")."""

    def test_banner_shows_the_name_the_server_resolved(self):
        html_out = scan_banner({
            "type": "checkin",
            "message": "Checked in successfully",
            "participant": {"id": 1, "name": "Bo"},
        })

        self.assertIn("✓ Bo — CHECKED IN", html_out)

    def test_banner_never_shows_an_address_even_if_one_is_sent(self):
        html_out = scan_banner({
            "type": "checkin",
            "message": "Checked in successfully",
            "participant": {"id": 1, "name": "Bo", "email": "robert@example.com"},
        })

        self.assertNotIn("@", html_out)
        self.assertNotIn("robert", html_out)

    def test_a_nameless_participant_falls_back_to_a_placeholder(self):
        for participant in ({}, {"id": 1}, {"id": 1, "name": None}, {"id": 1, "name": ""}):
            with self.subTest(participant=participant):
                html_out = scan_banner({
                    "type": "checkout",
                    "message": "Checked out successfully",
                    "participant": participant,
                })

                self.assertIn("✓ ? — CHECKED OUT", html_out)

    def test_the_name_is_escaped_like_every_other_backend_value(self):
        html_out = scan_banner({
            "type": "checkin",
            "message": "Checked in successfully",
            "participant": {"id": 1, "name": "<img src=x onerror=alert(1)>"},
        })

        self.assertNotIn("<img", html_out)
        self.assertIn("&lt;img", html_out)


class TestSupervisionWarningBanner(unittest.TestCase):
    """A scan that succeeds but leaves the room short of supervising adults
    (checkin#1436) still confirms the scan — in amber."""

    def test_warning_renders_amber_and_still_confirms_the_scan(self):
        html_out = scan_banner({
            "type": "checkout",
            "message": "Checked out successfully",
            "warning": "Warning: only 2 supervising adults remain in the building.",
            "participant": {"id": 1, "name": "Alex"},
        })

        self.assertIn("banner-warning", html_out)
        self.assertIn("CHECKED OUT", html_out)
        self.assertIn("only 2 supervising adults remain", html_out)

    def test_warning_is_escaped_like_every_other_backend_value(self):
        html_out = scan_banner({
            "type": "checkin",
            "warning": "<img src=x onerror=alert(1)>",
            "participant": {"id": 1, "name": "Alex"},
        })

        self.assertNotIn("<img", html_out)
        self.assertIn("&lt;img", html_out)

    def test_no_warning_leaves_the_ordinary_green_banner(self):
        html_out = scan_banner({
            "type": "checkin",
            "message": "Checked in successfully",
            "participant": {"id": 1, "name": "Alex"},
        })

        self.assertIn("banner-ok", html_out)
        self.assertNotIn("banner-warning", html_out)


def _git_stub(tags="", kiosk_sh=None, tag_commit="tagsha", main_head="mainsha"):
    """Stand in for the git calls resolve_update_target makes."""
    def run(argv, **kwargs):
        if argv[:3] == ["git", "tag", "-l"]:
            return tags
        if argv[:2] == ["git", "show"]:
            if kiosk_sh is None:
                raise subprocess.CalledProcessError(128, argv)
            return kiosk_sh
        if argv[:2] == ["git", "rev-list"]:
            return tag_commit + "\n"
        if argv[:2] == ["git", "rev-parse"]:
            return main_head + "\n"
        raise AssertionError(f"unexpected git call: {argv}")
    return run


class TestReleaseChannel(unittest.TestCase):
    """The Pi follows release tags, because the server deploys from them. A Pi
    on main runs client code whose server counterpart is not deployed."""

    def test_tags_are_ranked_by_version_not_by_date(self):
        # v1.10.0 must outrank v1.9.0, and a patch cut later must not outrank a
        # newer minor -- both of which -v:refname gets right and date sorting
        # does not. Asserting the flag because git, not us, does the sorting.
        with patch("client.subprocess.check_output") as co:
            co.return_value = "v1.2.1\nv1.2.0\n"
            self.assertEqual(latest_release_tag(), "v1.2.1")

        argv = co.call_args.args[0]
        self.assertIn("--sort=-v:refname", argv)
        self.assertIn(RELEASE_TAG_GLOB, argv)

    def test_no_tags_at_all_falls_back_to_main(self):
        with patch("client.subprocess.check_output", side_effect=_git_stub(tags="")):
            self.assertEqual(resolve_update_target(), "mainsha")

    def test_a_release_that_tracks_releases_is_adopted(self):
        stub = _git_stub(tags="v1.3.0\n", kiosk_sh=f"# {RELEASE_CHANNEL_MARKER}\n")
        with patch("client.subprocess.check_output", side_effect=stub):
            self.assertEqual(resolve_update_target(), "tagsha")

    def test_a_release_that_still_pulls_main_is_not_adopted(self):
        # The state on the day this landed: the newest release predates the
        # channel. Adopting it would check out a tree that pulls main straight
        # back, restarting the kiosk once per poll, forever.
        stub = _git_stub(tags="v1.2.1\n", kiosk_sh="git pull origin main\n")
        with patch("client.subprocess.check_output", side_effect=stub):
            self.assertEqual(resolve_update_target(), "mainsha")

    def test_a_tag_with_no_kiosk_sh_is_not_adopted(self):
        stub = _git_stub(tags="v0.1.0\n", kiosk_sh=None)
        with patch("client.subprocess.check_output", side_effect=stub):
            self.assertEqual(resolve_update_target(), "mainsha")

    def test_kiosk_sh_carries_the_marker_the_gate_greps_for(self):
        # The gate reads this marker out of a TAG's kiosk.sh. Drop the line here
        # and no future release is ever adopted -- silently, since the fallback
        # is the old behaviour and nothing else changes.
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "kiosk.sh")) as f:
            self.assertIn(RELEASE_CHANNEL_MARKER, f.read())

class TestParkedScanBanner(unittest.TestCase):
    """A park creates no Visit. The kiosk may not render one as a check-in."""

    REVIEW = {"type": "parked", "message": "Recorded for review."}

    def test_a_review_park_is_amber_not_a_checkin(self):
        html_out = scan_banner(self.REVIEW)

        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-ok", html_out)
        self.assertNotIn("CHECKED IN", html_out)
        self.assertIn("Recorded for review.", html_out)
        # The park body has no name; the "?" placeholder would read as a check-in.
        self.assertNotIn("?", html_out)

    def test_a_closed_facility_park_from_an_older_server_is_still_not_green(self):
        html_out = scan_banner({
            "type": "parked",
            "reason": "facility_closed",
            "message": "Recorded. Will project when a keyholder is present.",
        })

        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-ok", html_out)


class TestNoKeyholderPresence(unittest.TestCase):
    """With no keyholder in, a badge still checks in: the kiosk shows the person
    as present and its presence mirror treats them as inside."""

    def test_offline_in_with_no_keyholder_is_the_ordinary_saved_checkin(self):
        state = AttendanceState()
        state.seed_from_attendance({"attendance": [], "counts": {"total": 0, "keyholders": 0}})
        pushed = []
        state.push_event = pushed.append
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({}, 0, None)  # status 0 -> retry (unreachable)

        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertIn("banner-saved", pushed[-1]["html"])
        self.assertIn("CHECKED IN", pushed[-1]["html"])
        # The next badge from the same person is their way out.
        self.assertEqual(state.displayed_intent(7), "OUT")

    def test_a_no_keyholder_visit_on_the_roster_is_present(self):
        state = AttendanceState()
        state.seed_from_attendance({
            "attendance": [{"id": 1, "noKeyholder": True, "participant": {"id": 7, "isKeyholder": False}}],
            "counts": {"total": 1, "keyholders": 0},
            "safety": {"facilityOpen": False, "isLastKeyholder": False, "isTwoDeepViolation": False},
        })

        self.assertEqual(state.displayed_intent(7), "OUT")


class TestBackendClient(unittest.TestCase):
    def test_required_methods_exist(self):
        """Ensure BackendClient has the necessary structural methods."""
        # We don't need real keys or URLs for structural method existence checks
        # So we can pass strings and None.
        client = BackendClient("http://fake", "fake_key")

        self.assertTrue(hasattr(client, "post_scan"), "BackendClient is missing post_scan method")
        self.assertTrue(hasattr(client, "get_attendance"), "BackendClient is missing get_attendance method")
        self.assertTrue(hasattr(client, "_headers"), "BackendClient is missing _headers method")

class TestPostScanReplayFlag(unittest.TestCase):
    """The live attempt carries clientEventId (D4 try-first) but no replay
    flag -- the server's replay-only guards must not fire on it."""

    def _payload(self, **kwargs):
        client = BackendClient("http://fake", SigningKey(b"\x00" * 32))
        client.session = MagicMock()
        client.session.post.return_value = MagicMock(
            status_code=200, headers={}, json=lambda: {}
        )
        client.post_scan(
            7, client_event_id="evt-1", scanned_at="2026-08-18T10:00:00+00:00", **kwargs
        )
        return json.loads(client.session.post.call_args.kwargs["data"])

    def test_live_send_carries_the_event_id_but_no_replay_flag(self):
        payload = self._payload()
        self.assertEqual(payload["clientEventId"], "evt-1")
        self.assertNotIn("replay", payload)

    def test_replay_send_sets_the_flag(self):
        self.assertIs(self._payload(replay=True)["replay"], True)


class TestProxyBindsLocalhostOnly(unittest.TestCase):
    def test_server_binds_127_0_0_1_not_0_0_0_0(self):
        """H1: signing proxy must not be reachable over the LAN."""
        src = inspect.getsource(main)
        self.assertIn('"127.0.0.1"', src, "proxy must bind 127.0.0.1")
        self.assertNotIn("0.0.0.0", src, "proxy must not bind 0.0.0.0 (LAN-exposed kiosk-signature oracle)")

class TestExampleConfigMatchesDefaults(unittest.TestCase):
    def test_example_kiosk_path_matches_client_default(self):
        """A fresh Pi copies config.example.json, so its kiosk_path must not
        drift from the in-code default. Does not prove the backend serves it."""
        example = os.path.join(os.path.dirname(__file__), "config.example.json")
        with open(example) as f:
            cfg = json.load(f)
        self.assertEqual(cfg["kiosk_path"], DEFAULT_KIOSK_PATH)

class TestKioskClose(unittest.TestCase):
    """The kiosk decides a close from what it shows, online and offline alike
    (docs/in-design/CLOSE_AS_EVENT.md §2.2); the server records it as given."""

    def setUp(self):
        # These drive the second badge immediately; the dead-front has its own test.
        patcher = patch("client.REPEAT_READ_SECONDS", 0)
        patcher.start()
        self.addCleanup(patcher.stop)

    ROSTER = {
        "attendance": [
            {"participant": {"id": 9, "name": "Kim", "isKeyholder": True}},
            {"participant": {"id": 5, "name": "Sam", "isKeyholder": False}},
        ],
        "counts": {"keyholders": 1, "total": 2, "volunteers": 0, "youth": 1},
        "safety": {"isLastKeyholder": True, "isTwoDeepViolation": False},
    }

    def _state(self, two_deep_violation=False, roster=None):
        state = AttendanceState()
        state.scan_protocol = SCAN_PROTOCOL_VERSION
        roster = dict(roster or self.ROSTER)
        roster["safety"] = {"isLastKeyholder": True, "isTwoDeepViolation": two_deep_violation}
        state.seed_from_attendance(roster)
        state.current_counts = dict(roster["counts"])
        return state

    def _backend(self, body=None, status=200):
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = (body or {"type": "checkout", "participant": {"id": 9, "name": "Kim"}}, status, None)
        return backend

    def _offline(self):
        return self._backend({"error": "Connection refused"}, 0)

    def test_post_scan_sends_displayed_intent(self):
        client = BackendClient("http://fake", SigningKey(b"\x00" * 32))
        client.session = MagicMock()
        client.session.post.return_value = MagicMock(status_code=200, headers={}, json=lambda: {})
        client.post_scan(7, intent="IN")
        payload = json.loads(client.session.post.call_args.kwargs["data"])
        self.assertEqual(payload["intent"], "IN")
        client.post_scan(7, intent="OUT", clock_suspect=True)
        payload = json.loads(client.session.post.call_args.kwargs["data"])
        self.assertEqual(payload["intent"], "OUT")
        self.assertTrue(payload["clockSuspect"])

    def test_post_scan_still_sends_an_older_rows_shown_empty(self):
        client = BackendClient("http://fake", "fake_key")
        with patch.object(BackendClient, "_headers", return_value={}), \
             patch.object(client.session, "post") as post:
            post.return_value = Mock(status_code=200, json=Mock(return_value={}))
            client.post_scan(7, shown_empty=False)
            self.assertIs(json.loads(post.call_args.kwargs["data"])["shownEmpty"], False)

    def test_post_scan_sends_close_only_when_given(self):
        client = BackendClient("http://fake", "fake_key")
        with patch.object(BackendClient, "_headers", return_value={}), \
             patch.object(client.session, "post") as post:
            post.return_value = Mock(status_code=200, json=Mock(return_value={}))
            client.post_scan(7)
            self.assertEqual(json.loads(post.call_args.kwargs["data"]),
                             {"participantId": 7, "protocolVersion": SCAN_PROTOCOL_VERSION})
            client.post_scan(7, close="alone")
            self.assertEqual(json.loads(post.call_args.kwargs["data"])["close"], "alone")

    def test_get_server_version_parses_the_advertised_scan_protocol(self):
        client = BackendClient("http://fake", "fake_key")
        with patch.object(BackendClient, "_headers", return_value={}), \
             patch.object(client.session, "get") as get:
            get.return_value = Mock(status_code=200, json=Mock(
                return_value={"version": "abc", "scanProtocolVersion": 2}))
            self.assertEqual(client.get_server_version(), ("abc", 2, 200))
            # A server that predates the contract advertises nothing: treat as
            # the bare-toggle generation so replay behavior stays off.
            get.return_value = Mock(status_code=200, json=Mock(
                return_value={"version": "abc"}))
            self.assertEqual(client.get_server_version(), ("abc", 1, 200))

    def test_handle_scan_carries_local_presence_as_intent(self):
        state = self._state(roster={"attendance": [], "counts": {"total": 0}})
        state.push_event = lambda event: None
        backend = self._backend({"type": "checkin", "participant": {"id": 7, "name": "Alex"}})
        handle_scan(backend, state, Outbox(":memory:"), 7)
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "IN")
        handle_scan(backend, state, Outbox(":memory:"), 7)
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT")
        self.assertIsNone(backend.post_scan.call_args.kwargs["close"], "not a keyholder: never a close")

    def test_keyholder_shown_alone_closes_with_one_scan(self):
        roster = {"attendance": [{"participant": {"id": 9, "name": "Kim", "isKeyholder": True}}],
                  "counts": {"total": 1}}
        state = self._state(roster=roster)
        events = []
        state.push_event = events.append
        backend = self._backend({"type": "checkout", "facilityClosed": True, "participant": {"id": 9, "name": "Kim"}})

        handle_scan(backend, state, Outbox(":memory:"), 9)

        self.assertEqual(backend.post_scan.call_args.kwargs["close"], "alone")
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT")
        self.assertIn("The building should be empty", events[-1]["html"])
        self.assertEqual(state.present_ids, set())

    def test_keyholder_shown_with_others_leaves_and_is_prompted(self):
        state = self._state()
        events = []
        state.push_event = events.append
        backend = self._backend()

        handle_scan(backend, state, Outbox(":memory:"), 9)

        self.assertIsNone(backend.post_scan.call_args.kwargs["close"], "the first scan only leaves")
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT")
        self.assertIn("Sam", events[-1]["html"], "the prompt lists who the kiosk shows inside")
        self.assertIn("Scan again to close", events[-1]["html"])
        self.assertEqual(events[-1]["countdown"], FORCE_CLOSE_CONFIRM_SECONDS)

    def test_second_scan_of_the_same_badge_closes_as_out(self):
        state = self._state()
        events = []
        state.push_event = events.append
        backend = self._backend()

        handle_scan(backend, state, Outbox(":memory:"), 9)
        backend.post_scan.return_value = ({"type": "checkout", "facilityClosed": True, "participant": {"id": 9}}, 200, None)
        handle_scan(backend, state, Outbox(":memory:"), 9)

        self.assertEqual(backend.post_scan.call_args.kwargs["close"], "confirmed")
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT", "never toggles back IN")
        self.assertIn("BUILDING CLOSED", events[-1]["html"])

    def test_another_badge_cancels_the_prompt_and_scans_normally(self):
        state = self._state()
        state.push_event = lambda e: None
        backend = self._backend()

        handle_scan(backend, state, Outbox(":memory:"), 9)
        backend.post_scan.return_value = ({"type": "checkout", "participant": {"id": 5}}, 200, None)
        handle_scan(backend, state, Outbox(":memory:"), 5)
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT")
        self.assertIsNone(backend.post_scan.call_args.kwargs["close"])

        backend.post_scan.return_value = ({"type": "checkin", "participant": {"id": 9}}, 200, None)
        handle_scan(backend, state, Outbox(":memory:"), 9)
        self.assertIsNone(backend.post_scan.call_args.kwargs["close"], "the prompt ended with the other badge")
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "IN")

    def test_an_expired_prompt_closes_nothing(self):
        state = AttendanceState()
        state.arm_local_close(9, 0)
        self.assertFalse(state.take_local_close(9))

    def test_offline_is_the_same_decision_and_queues_the_close(self):
        state = self._state()
        events = []
        state.push_event = events.append
        backend = self._offline()
        ob = Outbox(":memory:")

        handle_scan(backend, state, ob, 9)   # leave + prompt
        self.assertIn("Scan again to close", events[-1]["html"])
        handle_scan(backend, state, ob, 9)   # close

        rows = ob.pending_rows()
        self.assertEqual([r[5] for r in rows], ["OUT", "OUT"])
        self.assertEqual([r[8] for r in rows], [None, "confirmed"])
        self.assertIn("BUILDING CLOSED", events[-1]["html"])
        self.assertIn("will sync", events[-1]["html"])

    def test_a_queued_close_empties_the_overlaid_view(self):
        state = self._state()
        state.push_event = lambda e: None
        ob = Outbox(":memory:")
        ob.enqueue("evt-1", 9, "2026-10-11T20:00:00+00:00", intent="OUT", close="alone")
        state.seed_from_attendance(self.ROSTER, ob.pending_rows())
        self.assertEqual(state.present_ids, set())

    def test_nothing_goes_live_before_the_server_speaks_close(self):
        state = self._state()
        state.scan_protocol = SCAN_PROTOCOL_VERSION - 1
        state.push_event = lambda e: None
        backend = self._backend()
        ob = Outbox(":memory:")
        handle_scan(backend, state, ob, 5)
        backend.post_scan.assert_not_called()
        self.assertEqual(len(ob.pending_rows()), 1)

    def test_a_refused_close_shows_why_and_stops_offering_the_close(self):
        roster = dict(self.ROSTER, attendance=[{"participant": {"id": 9, "name": "Kim", "isKeyholder": True}}])
        state = self._state(roster=roster)
        events = []
        state.push_event = events.append
        backend = self._backend({"type": "checkout", "facilityClosed": False, "closeRefused": True,
                                 "message": "Only a keyholder can close the building.",
                                 "participant": {"id": 9, "name": "Kim"}})

        handle_scan(backend, state, Outbox(":memory:"), 9)

        self.assertEqual(backend.post_scan.call_args.kwargs["close"], "alone")
        self.assertIn("Only a keyholder can close the building.", events[-1]["html"])
        self.assertNotIn("BUILDING CLOSED", events[-1]["html"])
        self.assertNotIn(9, state.known_keyholders)

    def test_a_roster_showing_someone_without_keys_takes_them_off_the_list(self):
        state = self._state()
        self.assertIn(9, state.known_keyholders)
        state.seed_from_attendance({"attendance": [{"participant": {"id": 9, "name": "Kim", "isKeyholder": False}}]})
        self.assertNotIn(9, state.known_keyholders)
        self.assertEqual(state.close_decision(9), (None, []))

    def test_a_keyholder_known_from_an_earlier_roster_can_still_close(self):
        state = self._state()
        state.seed_from_attendance({"attendance": [], "counts": {"total": 0}})
        state.present_ids = {9}  # their check-in is still queued
        self.assertEqual(state.close_decision(9), ("alone", []))
        self.assertEqual(state.close_decision(5), (None, []))

    def test_get_attendance_records_the_server_time_of_the_roster(self):
        client = BackendClient("http://fake", "fake_key")
        client.attendance_path = "/api/attendance"
        with patch.object(BackendClient, "_headers", return_value={}), \
             patch.object(client.session, "get") as get:
            get.return_value = Mock(status_code=200, headers={"Date": "Mon, 12 Oct 2026 20:58:30 GMT"},
                                    json=Mock(return_value={"attendance": []}))
            data, status = client.get_attendance()
        self.assertEqual(status, 200)
        self.assertEqual(data["rosterAsOf"], "2026-10-12T20:58:30+00:00")

    def test_a_close_carries_the_roster_time_it_was_made_from(self):
        roster = dict(self.ROSTER, attendance=[{"participant": {"id": 9, "name": "Kim", "isKeyholder": True}}],
                      rosterAsOf="2026-10-12T20:58:30+00:00")
        state = self._state(roster=roster)
        state.push_event = lambda e: None
        backend = self._backend()

        handle_scan(backend, state, Outbox(":memory:"), 9)

        self.assertEqual(backend.post_scan.call_args.kwargs["close"], "alone")
        self.assertEqual(backend.post_scan.call_args.kwargs["roster_as_of"], "2026-10-12T20:58:30+00:00")

    def test_a_held_close_shows_who_checked_in_and_the_same_badge_closes(self):
        roster = dict(self.ROSTER, attendance=[{"participant": {"id": 9, "name": "Kim", "isKeyholder": True}}])
        state = self._state(roster=roster)
        events = []
        state.push_event = events.append
        backend = self._backend({"type": "checkout", "facilityClosed": False, "participant": {"id": 9, "name": "Kim"},
                                 "closePrompt": "Sam checked in at 8:58 PM. Badge again to close the building."})

        handle_scan(backend, state, Outbox(":memory:"), 9)
        self.assertIn("Sam checked in at 8:58 PM", events[-1]["html"])
        self.assertEqual(events[-1]["countdown"], FORCE_CLOSE_CONFIRM_SECONDS)

        backend.post_scan.return_value = ({"type": "checkout", "facilityClosed": True, "participant": {"id": 9}}, 200, None)
        handle_scan(backend, state, Outbox(":memory:"), 9)
        self.assertEqual(backend.post_scan.call_args.kwargs["close"], "confirmed")
        self.assertIn("BUILDING CLOSED", events[-1]["html"])

    def test_a_queued_close_keeps_its_roster_time_for_the_drain(self):
        roster = dict(self.ROSTER, attendance=[{"participant": {"id": 9, "name": "Kim", "isKeyholder": True}}],
                      rosterAsOf="2026-10-12T20:58:30+00:00")
        state = self._state(roster=roster)
        state.push_event = lambda e: None
        ob = Outbox(":memory:")

        handle_scan(self._offline(), state, ob, 9)

        self.assertEqual(ob.pending_rows()[0][9], "2026-10-12T20:58:30+00:00")

    def test_supervision_caution_on_the_prompt_is_yellow_never_red(self):
        state = self._state(two_deep_violation=True)
        events = []
        state.push_event = events.append
        handle_scan(self._offline(), state, Outbox(":memory:"), 9)
        html_out = events[-1]["html"]
        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-error", html_out)
        self.assertIn("Two-deep", html_out)


def _state(total=None, present=(), served=()):
    """total=None: no real roster fetch yet (occupancy unknown). `served`: board
    roster paths already given the server's answer since the last fetch."""
    state = AttendanceState()
    if total is not None:
        state.counts_known = True
        state.current_counts = {"total": total}
        state.roster_generation = 1
    state.present_ids = set(present)
    state.served_generation = {p: state.roster_generation for p in served}
    state.push_event = lambda event: None
    return state


ROSTER = "/api/attendance"
CERTS = "/api/kioskdisplay/certifications"


class TestAttendancePollerPausesWhenEmpty(unittest.TestCase):
    """With one door, the poll pauses while the building is known empty, at any
    hour, and a badge here resumes it; otherwise the kiosk keeps asking."""

    def _run(self, state):
        backend = Mock(attendance_path="/attendance/current")
        backend.get_attendance.return_value = ({"counts": {"total": 1}}, 200)
        calls = {"n": 0}

        def fake_sleep(secs):
            calls["n"] += 1
            if calls["n"] >= 2:
                raise _StopLoop()

        with self.assertRaises(_StopLoop):
            attendance_poller(backend, state, Outbox(":memory:"), sleep_fn=fake_sleep)
        return backend

    def test_pauses_when_known_empty(self):
        self._run(_state(total=0)).get_attendance.assert_not_called()

    def test_polls_while_people_are_inside(self):
        self._run(_state(total=3, present={5})).get_attendance.assert_called()

    def test_polls_while_occupancy_is_unknown(self):
        self._run(_state()).get_attendance.assert_called()

    def test_a_badge_in_resumes_polling(self):
        state = _state(total=0)
        state.note_presence(5, checking_in=True)
        self._run(state).get_attendance.assert_called()

    def test_a_badge_during_the_fetch_is_not_seeded_over(self):
        """The roster may predate the badge: seeding it would drop the person
        and rest the kiosk with them inside."""
        state = _state()
        state.push_event = lambda e: None
        backend = Mock(attendance_path="/attendance/current")

        def fetch_while_badging():
            state.note_presence(7, checking_in=True)
            return ({"attendance": [], "counts": {"total": 0}}, 200)

        backend.get_attendance.side_effect = fetch_while_badging
        calls = {"n": 0}

        def fake_sleep(secs):
            calls["n"] += 1
            if calls["n"] >= 2:
                raise _StopLoop()

        with self.assertRaises(_StopLoop):
            attendance_poller(backend, state, Outbox(":memory:"), sleep_fn=fake_sleep)
        self.assertEqual(state.present_ids, {7})
        self.assertFalse(state.counts_known)

    def test_a_change_pushes_the_real_roster_to_the_board(self):
        """The board renders what the server sent instead of re-fetching into a
        proxy that may already be resting."""
        roster = {"attendance": [], "counts": {"total": 0}, "safety": {"isLastKeyholder": False}}
        backend = Mock(attendance_path="/attendance/current")
        backend.get_attendance.return_value = (roster, 200)
        state = _state(total=1, present={5})
        pushed = []
        state.push_event = pushed.append
        calls = {"n": 0}

        def fake_sleep(secs):
            calls["n"] += 1
            if calls["n"] >= 2:
                raise _StopLoop()

        with self.assertRaises(_StopLoop):
            attendance_poller(backend, state, Outbox(":memory:"), sleep_fn=fake_sleep)
        self.assertEqual(pushed, [{"html": "", **roster}])


class TestReseedKeepsUndeliveredScans(unittest.TestCase):
    """The server roster lags the kiosk: queued outbox rows are not on it. A
    reseed must not erase them, or the next badge from that person is sent in
    the wrong direction."""

    def _queue(self, ob, pid, intent, at):
        ob.enqueue(f"evt-{pid}-{at}", pid, at, intent=intent)

    def test_pending_in_survives_an_empty_roster(self):
        ob = Outbox(":memory:")
        self._queue(ob, 5, "IN", "2026-10-05T10:00:00Z")
        state = AttendanceState()
        state.seed_from_attendance({"attendance": []}, ob.pending_rows())
        self.assertEqual(state.displayed_intent(5), "OUT")

    def test_pending_out_survives_a_roster_that_still_lists_them(self):
        ob = Outbox(":memory:")
        self._queue(ob, 5, "OUT", "2026-10-05T10:00:00Z")
        state = AttendanceState()
        state.seed_from_attendance(
            {"attendance": [{"participant": {"id": 5, "isKeyholder": True}}]}, ob.pending_rows())
        self.assertEqual(state.displayed_intent(5), "IN")
        self.assertEqual(state.keyholder_ids, {5}, "keyholder ids stay roster-only")

    def test_last_pending_intent_wins(self):
        ob = Outbox(":memory:")
        self._queue(ob, 5, "IN", "2026-10-05T10:00:00Z")
        self._queue(ob, 5, "OUT", "2026-10-05T11:00:00Z")
        state = AttendanceState()
        state.seed_from_attendance({"attendance": []}, ob.pending_rows())
        self.assertEqual(state.displayed_intent(5), "IN")

    def test_poller_overlays_the_outbox(self):
        ob = Outbox(":memory:")
        self._queue(ob, 5, "IN", "2026-10-05T10:00:00Z")
        backend = Mock(attendance_path="/api/attendance")
        backend.get_attendance.return_value = ({"attendance": [], "counts": {"total": 0}}, 200)
        state = AttendanceState()
        state.push_event = lambda e: None
        calls = {"n": 0}

        def fake_sleep(_secs):
            calls["n"] += 1
            if calls["n"] >= 2:
                raise _StopLoop()

        with self.assertRaises(_StopLoop):
            attendance_poller(backend, state, ob, sleep_fn=fake_sleep)
        backend.get_attendance.assert_called()
        self.assertEqual(state.displayed_intent(5), "OUT")

    def test_apply_pending_without_a_roster(self):
        ob = Outbox(":memory:")
        self._queue(ob, 5, "IN", "2026-10-05T10:00:00Z")
        state = AttendanceState()
        state.apply_pending(ob.pending_rows())
        self.assertEqual(state.displayed_intent(5), "OUT")


class TestProxyRosterGets(unittest.TestCase):
    """The board's roster GETs reach the server except while the building is
    known empty and that board path has already had the real roster since the
    last fetch; then the proxy answers 204 with no body. The kiosk never
    answers them with a roster the server did not send."""

    def test_skips_when_known_empty_and_already_served(self):
        for path in (ROSTER, CERTS):
            self.assertTrue(skip_roster_get(_state(total=0, served=(ROSTER, CERTS)), "GET", path))

    def test_forwards_the_first_get_after_a_fetch_shows_empty(self):
        """A web checkout that empties the building: the board must get the
        real empty roster once, not keep showing who left."""
        self.assertFalse(skip_roster_get(_state(total=0), "GET", ROSTER))

    def test_each_board_path_gets_its_own_real_answer(self):
        self.assertFalse(skip_roster_get(_state(total=0, served=(ROSTER,)), "GET", CERTS))

    def test_forwards_while_people_are_inside(self):
        self.assertFalse(skip_roster_get(_state(total=3, present={5}, served=(ROSTER,)), "GET", ROSTER))

    def test_forwards_after_a_badge_in(self):
        self.assertFalse(skip_roster_get(_state(total=0, present={5}, served=(ROSTER,)), "GET", ROSTER))

    def test_forwards_while_occupancy_is_unknown(self):
        self.assertFalse(skip_roster_get(_state(), "GET", ROSTER))

    def test_forwards_scan_posts(self):
        self.assertFalse(skip_roster_get(_state(total=0, served=(ROSTER,)), "POST", "/api/scan"))

    def _proxy(self, state, method="GET", path=ROSTER, upstream_body=b"", status=200):
        handler = KioskHandler.__new__(KioskHandler)
        handler.path = path
        handler.headers = {}
        handler.state = state
        handler.backend = Mock(base_url="http://backend", signing_key=SigningKey.generate())
        handler.outbox = None
        handler.wfile = io.BytesIO()
        handler.rfile = io.BytesIO(b"")
        handler.send_response = Mock()
        handler.send_header = handler.end_headers = Mock()
        resp = Mock(status_code=status, headers={})
        resp.iter_content.return_value = [upstream_body]
        with patch("client.requests.request", return_value=resp) as upstream:
            handler._proxy_request(method)
        return handler, upstream

    def test_skipped_get_answers_204_with_no_body(self):
        handler, upstream = self._proxy(_state(total=0, served=(ROSTER,)))
        upstream.assert_not_called()
        handler.send_response.assert_called_once_with(204)
        self.assertEqual(handler.wfile.getvalue(), b"")

    def test_forwarded_get_passes_the_server_roster_through(self):
        roster = b'{"access": "full", "attendance": [], "counts": {"total": 3}}'
        handler, upstream = self._proxy(_state(total=3, present={5}), upstream_body=roster)
        upstream.assert_called_once()
        self.assertEqual(handler.wfile.getvalue(), roster)

    def test_the_real_empty_roster_is_served_once_then_rests(self):
        state = _state(total=0)
        _, first = self._proxy(state, upstream_body=b'{"attendance": []}')
        _, second = self._proxy(state)
        first.assert_called_once()
        second.assert_not_called()

    def test_a_board_roster_that_shows_empty_lets_the_board_rest(self):
        """The board's own roster GET seeds the kiosk; a real empty answer is
        credited to the generation it creates, so the next GET rests."""
        state = _state()
        empty = b'{"access": "full", "attendance": [], "counts": {"total": 0}}'
        self._proxy(state, upstream_body=empty)
        self.assertTrue(building_known_empty(state))
        _, upstream = self._proxy(state)
        upstream.assert_not_called()

    def test_a_board_check_in_makes_occupancy_unknown(self):
        """A check-in made on the board itself does not pass the scanner."""
        state = _state(total=0, served=(ROSTER,))
        self._proxy(state, method="POST", status=200)
        self.assertFalse(state.counts_known)
        self.assertFalse(skip_roster_get(state, "GET", ROSTER))

    def test_a_board_check_in_blocks_an_in_flight_seed(self):
        state = _state(total=0, served=(ROSTER,))
        _, seq = state.roster_snapshot(Outbox(":memory:"))
        self._proxy(state, method="POST", status=200)
        self.assertFalse(state.seed_from_attendance({"attendance": [], "counts": {"total": 0}}, since_seq=seq))
        self.assertFalse(state.counts_known)

    def test_a_failed_board_post_leaves_occupancy_known(self):
        state = _state(total=0, served=(ROSTER,))
        self._proxy(state, method="POST", status=400)
        self.assertTrue(state.counts_known)

    def test_other_board_posts_leave_occupancy_known(self):
        state = _state(total=0, served=(ROSTER,))
        self._proxy(state, method="POST", path="/api/auth/_log", status=200)
        self.assertTrue(state.counts_known)

    def test_an_answer_that_predates_a_newer_fetch_does_not_rest_the_board(self):
        """Evening close: the board's poll is in flight when the last badge-out
        reseeds; its stale answer must not count as the empty roster."""
        state = _state(total=1, present={5})
        stale = b'{"attendance": [{"participant": {"id": 5}}], "counts": {"total": 1}}'

        def reseed_empty_in_flight(**_kwargs):
            state.note_presence(5, checking_in=False)
            state.seed_from_attendance({"attendance": [], "counts": {"total": 0}})
            state.current_counts = {"total": 0}
            resp = Mock(status_code=200, headers={})
            resp.iter_content.return_value = [stale]
            return resp

        handler = KioskHandler.__new__(KioskHandler)
        handler.path = ROSTER
        handler.headers = {}
        handler.state = state
        handler.backend = Mock(base_url="http://backend", signing_key=SigningKey.generate())
        handler.outbox = None
        handler.wfile = io.BytesIO()
        handler.rfile = io.BytesIO(b"")
        handler.send_response = handler.send_header = handler.end_headers = Mock()
        with patch("client.requests.request", side_effect=reseed_empty_in_flight):
            handler._proxy_request("GET")
        self.assertTrue(building_known_empty(state))
        self.assertFalse(skip_roster_get(state, "GET", ROSTER))

    def test_only_the_board_roster_paths_count(self):
        state = _state(total=0, served=(ROSTER,))
        self.assertFalse(skip_roster_get(state, "GET", "/api/attendance/manual"))

    def test_a_board_reload_gets_the_real_roster_again(self):
        state = _state(total=0, served=(ROSTER, CERTS))
        self._proxy(state, path="/attendance/current?mode=kiosk", upstream_body=b"<html>")
        self.assertFalse(skip_roster_get(state, "GET", ROSTER))
        self.assertFalse(skip_roster_get(state, "GET", CERTS))

    def test_the_certifications_query_string_rests_too(self):
        handler, upstream = self._proxy(_state(total=0, served=(CERTS,)),
                                        path=CERTS + "?limit_to_present=true")
        upstream.assert_not_called()
        handler.send_response.assert_called_once_with(204)

    def test_static_assets_do_not_count_as_a_reload(self):
        state = _state(total=0, served=(ROSTER,))
        self._proxy(state, path="/_next/static/chunks/app.js", upstream_body=b"")
        self._proxy(state, path="/favicon.ico", upstream_body=b"")
        self.assertTrue(skip_roster_get(state, "GET", ROSTER))


class TestRepeatReadFilter(unittest.TestCase):
    """Reads of one badge within REPEAT_READ_SECONDS are one scan, filtered
    before the scan is queued or sent -- online and offline alike."""

    def setUp(self):
        self.now = 1000.0
        patcher = patch("client.time.monotonic", lambda: self.now)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.state = AttendanceState()
        self.state.scan_protocol = SCAN_PROTOCOL_VERSION
        self.state.push_event = lambda event: None
        self.outbox = Outbox(":memory:")

    def _online(self):
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"type": "checkin", "participant": {"id": 7}}, 200, None)
        return backend

    def _offline(self):
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"error": "Connection refused"}, 0, None)
        return backend

    def test_online_double_read_is_one_scan(self):
        backend = self._online()
        handle_scan(backend, self.state, self.outbox, 7)
        self.now += 2.9
        handle_scan(backend, self.state, self.outbox, 7)
        self.assertEqual(backend.post_scan.call_count, 1)
        self.assertEqual(self.outbox.pending_rows(), [])

    def test_offline_double_read_is_one_queued_scan(self):
        backend = self._offline()
        handle_scan(backend, self.state, self.outbox, 7)
        self.now += 0.3
        handle_scan(backend, self.state, self.outbox, 7)
        rows = self.outbox.pending_rows()
        self.assertEqual([r[5] for r in rows], ["IN"], "never queued IN then OUT")
        self.assertIn(7, self.state.present_ids)

    def test_the_window_slides_while_the_badge_is_held(self):
        backend = self._offline()
        handle_scan(backend, self.state, self.outbox, 7)
        for _ in range(4):                                 # held 8 s, read every 2 s
            self.now += 2.0
            handle_scan(backend, self.state, self.outbox, 7)
        self.assertEqual([r[5] for r in self.outbox.pending_rows()], ["IN"], "a held badge never toggles")
        self.now += 3.0                                    # lifted, then badged again
        handle_scan(backend, self.state, self.outbox, 7)
        self.assertEqual([r[5] for r in self.outbox.pending_rows()], ["IN", "OUT"])

    def test_in_then_out_four_seconds_apart_is_two_scans_online(self):
        backend = self._online()
        handle_scan(backend, self.state, self.outbox, 7)
        self.now += 4
        handle_scan(backend, self.state, self.outbox, 7)
        intents = [c.kwargs["intent"] for c in backend.post_scan.call_args_list]
        self.assertEqual(intents, ["IN", "OUT"])

    def test_in_then_out_four_seconds_apart_is_two_scans_offline(self):
        backend = self._offline()
        handle_scan(backend, self.state, self.outbox, 7)
        self.now += 4
        handle_scan(backend, self.state, self.outbox, 7)
        self.assertEqual([r[5] for r in self.outbox.pending_rows()], ["IN", "OUT"])

    def test_other_badges_are_not_filtered(self):
        backend = self._online()
        handle_scan(backend, self.state, self.outbox, 7)
        handle_scan(backend, self.state, self.outbox, 8)
        self.assertEqual(backend.post_scan.call_count, 2)

    def test_online_close_confirm_after_three_seconds_closes(self):
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"type": "checkout", "participant": {"id": 9}}, 200, None)
        self.state.known_keyholders = {9}
        self.state.present_ids = {9, 5}
        handle_scan(backend, self.state, self.outbox, 9)    # OUT, close prompt armed
        self.now += 1
        handle_scan(backend, self.state, self.outbox, 9)    # double-read: no confirm
        self.assertEqual(backend.post_scan.call_count, 1)
        self.now += 3.5
        handle_scan(backend, self.state, self.outbox, 9)    # the human's second badge
        confirm = backend.post_scan.call_args.kwargs
        self.assertEqual((confirm["close"], confirm["intent"]), ("confirmed", "OUT"))

    def test_offline_close_confirm_after_three_seconds_closes(self):
        backend = self._offline()
        self.state.known_keyholders = {9}
        self.state.present_ids = {9, 5}
        handle_scan(backend, self.state, self.outbox, 9)    # OUT, close prompt armed
        self.now += 0.5
        handle_scan(backend, self.state, self.outbox, 9)    # double-read: no confirm
        self.assertEqual(len(self.outbox.pending_rows()), 1)
        self.now += 3
        handle_scan(backend, self.state, self.outbox, 9)
        rows = self.outbox.pending_rows()
        self.assertEqual([(r[5], r[8]) for r in rows], [("OUT", None), ("OUT", "confirmed")])


    def test_held_badge_slides_the_online_close_window(self):
        events = []
        self.state.push_event = events.append
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"type": "checkout", "participant": {"id": 9}}, 200, None)
        self.state.known_keyholders = {9}
        self.state.present_ids = {9, 5}
        handle_scan(backend, self.state, self.outbox, 9)    # OUT, close prompt armed
        prompt = events[-1]
        for _ in range(7):                                  # held 14 s
            self.now += 2
            handle_scan(backend, self.state, self.outbox, 9)
        self.assertEqual(events[-1], prompt, "each held read restarts the on-screen countdown")
        self.assertEqual(self.state.local_close_deadline, self.now + 15)
        self.now += 14                                      # 28 s after the prompt, 14 after the last read
        handle_scan(backend, self.state, self.outbox, 9)
        self.assertEqual(backend.post_scan.call_args.kwargs["close"], "confirmed")

    def test_held_badge_slides_the_offline_close_window(self):
        events = []
        self.state.push_event = events.append
        backend = self._offline()
        self.state.known_keyholders = {9}
        self.state.present_ids = {9, 5}
        handle_scan(backend, self.state, self.outbox, 9)    # OUT, close prompt armed
        prompt = events[-1]
        self.now += 2
        handle_scan(backend, self.state, self.outbox, 9)
        self.assertEqual(events[-1], prompt)
        self.assertEqual(self.state.local_close_deadline, self.now + 15)
        self.now += 14                                      # 16 s after the prompt
        handle_scan(backend, self.state, self.outbox, 9)
        self.assertEqual([(r[5], r[8]) for r in self.outbox.pending_rows()], [("OUT", None), ("OUT", "confirmed")])

    def test_repeat_read_without_a_close_shows_nothing(self):
        events = []
        self.state.push_event = events.append
        backend = self._online()
        handle_scan(backend, self.state, self.outbox, 7)
        self.now += 1
        handle_scan(backend, self.state, self.outbox, 7)
        self.assertEqual(len(events), 1)

    def test_another_badges_repeat_read_leaves_the_close_window(self):
        self.state.arm_local_close(9, 15, "<div>prompt</div>")
        self.state.is_repeat_read(5)
        self.now += 1
        self.assertIsNone(self.state.slide_close(5))
        self.assertEqual(self.state.local_close_deadline, 1015.0)

    def test_banner_cleared_after_close_completes(self):
        self.state.arm_local_close(9, 15, "<div>prompt</div>")
        self.assertTrue(self.state.take_local_close(9))
        self.assertIsNone(self.state.local_close_banner)
        self.assertIsNone(self.state.slide_close(9))

    def test_banner_cleared_after_expiry(self):
        self.state.arm_local_close(9, 15, "<div>prompt</div>")
        self.now += 16
        self.assertIsNone(self.state.slide_close(9))
        self.assertIsNone(self.state.local_close_banner)


class TestKioskOwnView(unittest.TestCase):
    """The kiosk never blanks: when the server can't answer the roster GET it
    serves its own view -- last roster plus its queued scans -- marked offline."""

    ROSTER = {
        "access": "full",
        "attendance": [
            {"id": 1, "arrivedAt": "2026-10-11T15:00:00Z",
             "participant": {"id": 9, "name": "Sam", "isKeyholder": True, "isYouth": False}},
            {"id": 2, "arrivedAt": "2026-10-11T15:05:00Z",
             "participant": {"id": 5, "name": "Ana", "isKeyholder": False, "isYouth": True}},
        ],
        "counts": {"total": 2, "keyholders": 1, "volunteers": 0, "youth": 1, "needReview": 3},
        "safety": {"facilityOpen": True, "isLastKeyholder": True, "isTwoDeepViolation": False},
    }

    def _outbox(self, *scans):
        ob = Outbox(":memory:")
        for i, (pid, intent) in enumerate(scans):
            ob.enqueue(f"e{i}", pid, f"2026-10-11T16:0{i}:00Z", None, intent=intent)
        return ob

    def _proxy_get(self, state, outbox, path="/api/attendance", status=200, body=b"", error=None, resp_headers=None):
        handler = KioskHandler.__new__(KioskHandler)
        handler.path = path
        handler.headers = {}
        handler.state = state
        handler.outbox = outbox
        handler.backend = Mock(base_url="http://backend", signing_key=SigningKey.generate())
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = handler.end_headers = Mock()
        resp = Mock(status_code=status, headers=resp_headers or {})
        resp.iter_content.return_value = [body]
        upstream = patch("client.requests.request", side_effect=error) if error else \
            patch("client.requests.request", return_value=resp)
        with upstream:
            handler._proxy_request("GET")
        return handler

    def test_unreachable_server_serves_the_roster_with_queued_scans(self):
        state = AttendanceState()
        state.seed_from_attendance(self.ROSTER)
        ob = self._outbox(("5", "OUT"), ("7", "IN"))
        state.apply_pending(ob.pending_rows())

        handler = self._proxy_get(state, ob, error=ConnectionError("down"))

        handler.send_response.assert_called_once_with(200)
        view = json.loads(handler.wfile.getvalue())
        self.assertIsNotNone(view["kioskAsOf"])
        self.assertEqual([v["participant"]["id"] for v in view["attendance"]], [9, 7])
        added = view["attendance"][1]
        self.assertEqual(added["participant"]["name"], UNKNOWN_PERSON_NAME)
        self.assertEqual(added["arrivedAt"], "2026-10-11T16:01:00Z")
        self.assertEqual(view["counts"], {"total": 2, "keyholders": 1, "volunteers": 0,
                                          "youth": 1, "needReview": 3})
        self.assertNotIn("safety", view, "the kiosk cannot recompute supervision")

    def test_warming_503_serves_the_kiosk_view_too(self):
        state = AttendanceState()
        state.seed_from_attendance(self.ROSTER)
        handler = self._proxy_get(state, self._outbox(), status=503, body=b"<html>waking</html>")
        view = json.loads(handler.wfile.getvalue())
        self.assertIsNotNone(view["kioskAsOf"])
        self.assertEqual(view["safety"], self.ROSTER["safety"], "unchanged roster keeps its flags")

    def test_unreachable_server_before_any_roster_shows_queued_scans(self):
        state = AttendanceState()
        ob = self._outbox(("7", "IN"))
        state.apply_pending(ob.pending_rows())
        view = json.loads(self._proxy_get(state, ob, error=ConnectionError("down")).wfile.getvalue())
        self.assertEqual([v["participant"]["id"] for v in view["attendance"]], [7])
        self.assertEqual(view["counts"]["total"], 1)
        self.assertIsNone(view["kioskAsOf"], "no roster yet: stale with no time")

    def test_other_paths_still_answer_502(self):
        handler = self._proxy_get(AttendanceState(), None, path="/api/scan", error=ConnectionError("down"))
        handler.send_response.assert_called_once_with(502)

    def test_a_proxied_roster_seeds_the_kiosk_view_with_queued_scans(self):
        state = AttendanceState()
        ob = self._outbox(("5", "OUT"))
        self._proxy_get(state, ob, body=json.dumps(self.ROSTER).encode())
        self.assertEqual(state.present_ids, {9})
        self.assertEqual(state.known_people[5]["name"], "Ana")

    def test_a_proxied_roster_records_the_server_time_it_is_from(self):
        state = AttendanceState()
        self._proxy_get(state, self._outbox(), body=json.dumps(self.ROSTER).encode(),
                        resp_headers={"Date": "Mon, 12 Oct 2026 20:58:30 GMT"})
        self.assertEqual(state.roster_as_of, "2026-10-12T20:58:30+00:00", "a close made from this view sends it")

    def test_the_own_view_is_marked_with_the_roster_time(self):
        state = AttendanceState()
        with patch("client.now_iso", return_value="2026-10-11T22:00:00Z"):
            state.seed_from_attendance(self.ROSTER)
        state.note_presence(5, checking_in=False)
        view = state.attendance_view()
        self.assertEqual([v["participant"]["id"] for v in view["attendance"]], [9])
        self.assertEqual(view["kioskAsOf"], "2026-10-11T22:00:00Z", "never presented as fresh")

    def test_the_own_view_before_any_roster_states_no_safety(self):
        """Not knowing is never an all-clear: the page reads a missing safety
        object as unknown."""
        view = AttendanceState().attendance_view()
        self.assertNotIn("safety", view)
        self.assertIsNone(view["kioskAsOf"])


class TestCloseBanners(unittest.TestCase):
    ROSTER = TestKioskOwnView.ROSTER

    def _offline(self):
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"error": "Connection refused"}, 0, None)
        return backend

    def test_online_one_scan_close_says_the_building_should_be_empty(self):
        body = {"type": "checkout", "facilityClosed": True, "participant": {"name": "Sam"},
                "message": "Checked out and Facility closed"}
        self.assertIn(CLOSING_ALONE_COPY, scan_banner(body))
        self.assertNotIn(CLOSING_ALONE_COPY, _scan_result_banner_html(body, 200, confirmed=True)[0])
        self.assertNotIn(CLOSING_ALONE_COPY, scan_banner({**body, "facilityClosed": False}))

    def test_offline_keyholder_shown_alone_closes_in_one_scan(self):
        state = AttendanceState()
        state.seed_from_attendance(self.ROSTER)
        state.note_presence(5, checking_in=False)
        events = []
        state.push_event = events.append
        handle_scan(self._offline(), state, Outbox(":memory:"), 9)
        self.assertIn(CLOSING_ALONE_COPY, events[-1]["html"])
        self.assertNotIn("countdown", events[-1])

    def test_offline_close_prompt_lists_who_is_shown_inside(self):
        state = AttendanceState()
        state.seed_from_attendance(self.ROSTER)
        state.note_presence(7, checking_in=True)
        events = []
        state.push_event = events.append
        handle_scan(self._offline(), state, Outbox(":memory:"), 9)
        self.assertIn(f"Still inside: Ana, {UNKNOWN_PERSON_NAME}", events[-1]["html"])
        self.assertNotIn(CLOSING_ALONE_COPY, events[-1]["html"])


if __name__ == "__main__":
    unittest.main()
