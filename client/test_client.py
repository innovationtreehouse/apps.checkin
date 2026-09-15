import inspect
import json
import os
import subprocess
import unittest
from datetime import datetime
from unittest.mock import MagicMock, Mock, patch

from nacl.signing import SigningKey

from client import (
    AttendanceState,
    RELEASE_CHANNEL_MARKER,
    RELEASE_TAG_GLOB,
    BackendClient,
    DEFAULT_KIOSK_PATH,
    CLOSED_HOLD_COPY,
    CLOSED_HOLD_DWELL_S,
    OFFLINE_HOLD_COPY,
    FORCE_CLOSE_CONFIRM_SECONDS,
    _saved_banner_html,
    _scan_result_banner_html,
    attendance_poller,
    handle_scan,
    latest_release_tag,
    main,
    resolve_update_target,
)
from outbox import Outbox, in_closed_window


class _StopLoop(Exception):
    """Sentinel to escape attendance_poller's `while True` in tests."""


def scan_banner(body, status=200):
    # handle_scan now takes an outbox and delegates the markup to this helper;
    # calling it directly tests the same banner without faking a backend.
    return _scan_result_banner_html(body, status)[0]


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
    (checkin#1436) still confirms the scan — in amber, which dwells longer."""

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
    """A park creates no Visit. The kiosk may not render one as a check-in, and
    must not blame the member for a keyholder who has not badged yet."""

    CLOSED = {
        "type": "parked",
        "reason": "facility_closed",
        "message": "Recorded. Will project when a keyholder is present.",
    }
    REVIEW = {"type": "parked", "message": "Recorded for review."}

    def test_the_hold_is_amber_and_confirms_the_scan(self):
        html_out = scan_banner(self.CLOSED)

        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-ok", html_out)
        self.assertNotIn("banner-error", html_out)
        self.assertIn(CLOSED_HOLD_COPY, html_out)

    def test_the_copy_names_the_keyholder_as_what_is_awaited(self):
        # The member did nothing wrong and cannot fix "no keyholder has
        # badged" -- the banner reports their scan landed and what it waits on.
        self.assertEqual(
            CLOSED_HOLD_COPY,
            "Scan successful, waiting for key holder before opening the building",
        )

    def test_holds_for_thirty_seconds_without_fading(self):
        _, countdown, dwell = _scan_result_banner_html(self.CLOSED, 200)

        self.assertEqual(dwell, 30)
        self.assertEqual(dwell, CLOSED_HOLD_DWELL_S)
        # The dwell is only honoured because .banner-warning suppresses the 5s
        # fade; on any class that does not, the banner silently blanks at 5s.
        self.assertIn("banner-warning", scan_banner(self.CLOSED))
        # Not a force-close countdown -- nothing to tick, nothing to confirm.
        self.assertEqual(countdown, 0)

    def test_no_park_shows_the_placeholder_it_has_no_name_for(self):
        self.assertNotIn("?", scan_banner(self.CLOSED))
        self.assertNotIn("?", scan_banner(self.REVIEW))

    def test_a_review_park_also_stops_reading_as_a_checkin(self):
        # Double-in and out-without-in park too, and used to fall through to
        # the green tick -- the same "reads as a check-in" look, one branch on.
        html_out = scan_banner(self.REVIEW)

        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-ok", html_out)
        self.assertNotIn("CHECKED IN", html_out)
        self.assertIn("Recorded for review.", html_out)
        self.assertNotIn(CLOSED_HOLD_COPY, html_out)

    def test_a_park_from_a_server_too_old_to_send_a_reason_is_still_not_green(self):
        # ops runs a release whose closed-facility park carries no `reason`, so
        # until the server ships that hold arrives here indistinguishable from a
        # review park. It must not be a green tick either.
        html_out = scan_banner({k: v for k, v in self.CLOSED.items() if k != "reason"})

        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-ok", html_out)

    def test_the_dwell_reaches_the_display(self):
        state = AttendanceState()
        pushed = []
        state.push_event = pushed.append
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = (self.CLOSED, 200, None)

        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertEqual(pushed[-1]["dwell"], CLOSED_HOLD_DWELL_S)


class TestOfflineClosedHoldBanner(unittest.TestCase):
    """A scan queued while disconnected shows a hedged hold — not a confident
    'CHECKED IN' the server will actually park — when the last poll knew of no
    keyholder. Hedged, not the server's CLOSED_HOLD_COPY: offline the kiosk can't
    tell an arriving keyholder (who opens the building) from a member."""

    def test_offline_in_with_no_keyholder_shows_the_hedged_hold(self):
        html_out, dwell = _saved_banner_html(2, "IN", facility_closed=True)

        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-saved", html_out)
        self.assertNotIn("CHECKED IN", html_out)
        self.assertIn(OFFLINE_HOLD_COPY, html_out)
        # Hedged copy, never the server's "waiting for key holder" claim — wrong
        # for a keyholder arriving to open, whom the client can't detect offline.
        self.assertNotIn(CLOSED_HOLD_COPY, html_out)
        # Still tells the operator it is queued, and holds as long as the online hold.
        self.assertIn("2 waiting", html_out)
        self.assertEqual(dwell, CLOSED_HOLD_DWELL_S)

    def test_offline_in_with_a_keyholder_present_is_the_ordinary_saved_banner(self):
        html_out, dwell = _saved_banner_html(1, "IN", facility_closed=False)

        self.assertIn("banner-saved", html_out)
        self.assertIn("CHECKED IN", html_out)
        self.assertNotIn(OFFLINE_HOLD_COPY, html_out)
        self.assertEqual(dwell, 0)

    def test_offline_out_is_never_a_closed_hold(self):
        # Leaving a closed building is not a hold — only an IN can be held.
        html_out, dwell = _saved_banner_html(1, "OUT", facility_closed=True)

        self.assertIn("banner-saved", html_out)
        self.assertIn("CHECKED OUT", html_out)
        self.assertNotIn(OFFLINE_HOLD_COPY, html_out)
        self.assertEqual(dwell, 0)

    def test_facility_closed_is_unknown_not_closed_before_the_first_poll(self):
        # Zeroed startup counts must not read as closed, or every offline IN
        # before the first poll would wrongly show the hold.
        state = AttendanceState()
        self.assertFalse(state.facility_closed())
        # A poll flips attendance_seen; facility_closed then keys off the counts.
        state.seed_from_attendance({"attendance": []})
        self.assertTrue(state.facility_closed())
        state.current_counts = {"keyholders": 1}
        self.assertFalse(state.facility_closed())

    def test_unreachable_server_renders_the_hold_when_last_poll_had_no_keyholder(self):
        state = AttendanceState()
        state.attendance_seen = True
        state.current_counts = {"total": 0, "keyholders": 0, "volunteers": 0, "students": 0}
        pushed = []
        state.push_event = pushed.append
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({}, 0, None)  # status 0 -> retry (unreachable)

        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertIn(OFFLINE_HOLD_COPY, pushed[-1]["html"])
        self.assertEqual(pushed[-1]["dwell"], CLOSED_HOLD_DWELL_S)

    def test_unreachable_server_before_first_poll_is_the_ordinary_saved_banner(self):
        state = AttendanceState()  # attendance_seen defaults False
        pushed = []
        state.push_event = pushed.append
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({}, 0, None)

        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertNotIn(OFFLINE_HOLD_COPY, pushed[-1]["html"])
        self.assertIn("banner-saved", pushed[-1]["html"])


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

class TestForceCloseConfirm(unittest.TestCase):
    """§5.23 explicit confirm: the warning arms a token, the next scan spends it."""

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

    def test_handle_scan_carries_local_presence_as_intent(self):
        state = AttendanceState()
        state.push_event = lambda event: None
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = (
            {"type": "checkin", "participant": {"id": 7, "name": "Alex"}},
            200,
            None,
        )
        handle_scan(backend, state, Outbox(":memory:"), 7)
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "IN")
        handle_scan(backend, state, Outbox(":memory:"), 7)
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT")

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

    def test_post_scan_sends_the_token_only_when_one_is_held(self):
        client = BackendClient("http://fake", "fake_key")
        with patch.object(BackendClient, "_headers", return_value={}), \
             patch.object(client.session, "post") as post:
            post.return_value = Mock(status_code=200, json=Mock(return_value={}))

            client.post_scan(7)
            self.assertEqual(json.loads(post.call_args.kwargs["data"]),
                             {"participantId": 7, "protocolVersion": 2})

            client.post_scan(7, "tok-1")
            self.assertEqual(json.loads(post.call_args.kwargs["data"]),
                             {"participantId": 7, "protocolVersion": 2, "forceCloseToken": "tok-1"})

    def test_token_is_single_use_and_dies_with_the_countdown(self):
        state = AttendanceState()
        self.assertIsNone(state.take_confirm())

        state.arm_confirm("tok", 15)
        self.assertEqual(state.take_confirm(), "tok")
        self.assertIsNone(state.take_confirm(), "a spent token must not confirm twice")

        state.arm_confirm("tok", 0)  # countdown already over
        self.assertIsNone(state.take_confirm(), "an expired countdown confirms nothing")

    def test_warning_arms_the_countdown_and_the_next_scan_confirms(self):
        state = AttendanceState()
        events = []
        state.push_event = events.append
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({
            "type": "warning", "error": "others are here",
            "forceCloseToken": "tok-1", "confirmSeconds": 15,
        }, 400, None)

        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertIsNone(backend.post_scan.call_args.kwargs["force_close_token"])
        self.assertEqual(events[0]["countdown"], 15)
        self.assertIn('id="fc-countdown"', events[0]["html"])

        backend.post_scan.return_value = ({
            "type": "checkout", "message": "Checked out and Facility closed",
            "participant": {"id": 7, "name": "Kim"},
        }, 200, None)
        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertEqual(backend.post_scan.call_args.kwargs["force_close_token"], "tok-1")
        self.assertEqual(events[1]["countdown"], 0)

    def test_last_keyholder_confirm_repeats_out_not_toggles_to_in(self):
        """The warning scan discards the present keyholder from the local view,
        so displayed_intent would flip the confirm to IN and the server would
        park it instead of closing. A live token pins the confirm OUT."""
        state = AttendanceState()
        state.push_event = lambda event: None
        state.present_ids.add(7)  # last keyholder is currently present
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({
            "type": "warning", "error": "you are the last keyholder",
            "forceCloseToken": "tok-1", "confirmSeconds": 15,
        }, 400, None)

        handle_scan(backend, state, Outbox(":memory:"), 7)
        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT")

        backend.post_scan.return_value = ({
            "type": "checkout", "message": "Checked out and Facility closed",
            "participant": {"email": "k@example.com"},
        }, 200, None)
        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT",
                         "the confirm must repeat OUT, not toggle to IN")
        self.assertEqual(backend.post_scan.call_args.kwargs["force_close_token"], "tok-1")

    def test_a_queued_confirm_carries_its_token_into_the_outbox(self):
        """Without this the drain replays token-less and the server parks the
        close for review -- silently undoing the confirm the keyholder gave."""
        state = AttendanceState()
        state.push_event = lambda event: None
        state.arm_confirm("tok-1", 15)
        outbox = Outbox(":memory:")
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"error": "unreachable"}, 0, None)

        handle_scan(backend, state, outbox, 7)

        rows = outbox.pending_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][4], "tok-1")

    def test_a_queued_scan_behind_a_predecessor_keeps_its_token_too(self):
        state = AttendanceState()
        state.push_event = lambda event: None
        outbox = Outbox(":memory:")
        outbox.enqueue("evt-0", 7, "2026-08-21T10:00:00+00:00")
        state.arm_confirm("tok-2", 15)
        backend = Mock(attendance_path=None)

        handle_scan(backend, state, outbox, 7)

        backend.post_scan.assert_not_called()
        queued = [r for r in outbox.pending_rows() if r[0] != "evt-0"]
        self.assertEqual(queued[0][4], "tok-2")

class TestAttendancePollerClosedWindow(unittest.TestCase):
    """§3.1/Q17: unlike the outbox drain, the poller had no closed-window
    gate -- a 24/7 kiosk pointed at prod defeats the overnight curfew with
    signed GETs every 30s."""

    def _run(self, in_closed_window_fn, iterations=2):
        backend = Mock(attendance_path="/attendance/current")
        backend.get_attendance.return_value = ({"counts": {"total": 1}}, 200)
        state = AttendanceState()
        state.push_event = lambda event: None

        calls = {"n": 0}

        def fake_sleep(secs):
            calls["n"] += 1
            if calls["n"] >= iterations:
                raise _StopLoop()

        with self.assertRaises(_StopLoop):
            attendance_poller(backend, state, sleep_fn=fake_sleep,
                               in_closed_window_fn=in_closed_window_fn)
        return backend

    def test_swallows_the_fetch_at_2330(self):
        backend = self._run(lambda: in_closed_window(datetime(2026, 8, 18, 23, 30)))
        backend.get_attendance.assert_not_called()

    def test_polls_at_1200(self):
        backend = self._run(lambda: in_closed_window(datetime(2026, 8, 18, 12, 0)))
        backend.get_attendance.assert_called()


class TestOfflineForceClose(unittest.TestCase):
    """Offline the server mints no token, so the kiosk runs the last-keyholder
    warning + two-scan confirm itself and flags the queued close as confirmed."""

    ROSTER = {
        "attendance": [
            {"participant": {"id": 9, "isKeyholder": True}},
            {"participant": {"id": 5, "isKeyholder": False}},
        ],
        "counts": {"keyholders": 1, "total": 2, "volunteers": 0, "youth": 1},
        "safety": {"isLastKeyholder": True, "isTwoDeepViolation": False},
    }

    def _state(self, two_deep_violation=False):
        state = AttendanceState()
        roster = dict(self.ROSTER)
        roster["safety"] = {"isLastKeyholder": True, "isTwoDeepViolation": two_deep_violation}
        state.seed_from_attendance(roster)
        state.current_counts = dict(roster["counts"])
        return state

    def _backend_offline(self):
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"error": "Connection refused"}, 0, None)
        return backend

    def test_seed_tracks_keyholders_and_two_deep(self):
        state = self._state(two_deep_violation=True)
        self.assertEqual(state.keyholder_ids, {9})
        self.assertTrue(state.last_two_deep_violation)
        self.assertTrue(state.offline_last_keyholder(9))
        self.assertFalse(state.offline_last_keyholder(5), "a non-keyholder is never the last keyholder")

    def test_not_last_keyholder_when_another_keyholder_present(self):
        state = self._state()
        state.keyholder_ids = {9, 3}
        state.current_counts = {"keyholders": 2, "total": 3}
        self.assertFalse(state.offline_last_keyholder(9))

    def test_local_close_is_bound_single_use_and_expires(self):
        state = AttendanceState()
        self.assertFalse(state.take_local_close(9))
        state.arm_local_close(9, 15)
        self.assertFalse(state.take_local_close(5), "another badge must not consume it")
        self.assertTrue(state.take_local_close(9))
        self.assertFalse(state.take_local_close(9), "single use")
        state.arm_local_close(9, 0)  # countdown already over
        self.assertFalse(state.take_local_close(9), "an expired countdown confirms nothing")

    def test_offline_last_keyholder_out_warns_and_arms_without_confirming(self):
        state = self._state()
        events = []
        state.push_event = events.append
        backend = self._backend_offline()
        ob = Outbox(":memory:")

        handle_scan(backend, state, ob, 9)

        self.assertIn("banner-warning", events[-1]["html"])
        self.assertIn("last key holder", events[-1]["html"].lower())
        self.assertEqual(events[-1]["countdown"], FORCE_CLOSE_CONFIRM_SECONDS)
        self.assertFalse(backend.post_scan.call_args.kwargs["force_close_confirmed"])
        rows = ob.pending_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][5], "OUT")   # intent
        self.assertEqual(rows[0][7], 0)        # not yet confirmed

    def test_second_scan_confirms_the_close_as_out_not_in(self):
        state = self._state()
        state.push_event = lambda e: None
        backend = self._backend_offline()
        ob = Outbox(":memory:")

        handle_scan(backend, state, ob, 9)   # warn + arm; flips presence to absent
        events = []
        state.push_event = events.append
        handle_scan(backend, state, ob, 9)   # confirm

        rows = ob.pending_rows()
        self.assertEqual(len(rows), 2)
        confirm = rows[1]
        self.assertEqual(confirm[5], "OUT", "the confirm repeats OUT, never toggles to IN")
        self.assertEqual(confirm[7], 1, "the confirm carries force_close_confirmed")
        self.assertIn("BUILDING CLOSED", events[-1]["html"])
        self.assertEqual(backend.post_scan.call_count, 1, "confirm queues behind the warning, no live post")

    def test_offline_supervision_caution_is_yellow_never_red(self):
        state = self._state(two_deep_violation=True)
        events = []
        state.push_event = events.append

        handle_scan(self._backend_offline(), state, Outbox(":memory:"), 9)

        html_out = events[-1]["html"]
        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-error", html_out)
        self.assertIn("Two-deep", html_out)


if __name__ == "__main__":
    unittest.main()
