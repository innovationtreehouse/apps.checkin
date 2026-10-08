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
    FORCE_CLOSE_CONFIRM_SECONDS,
    _saved_banner_html,
    _scan_result_banner_html,
    attendance_poller,
    handle_scan,
    latest_release_tag,
    main,
    resolve_update_target,
    skip_kiosk_keepalive,
    synthetic_keepalive_body,
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

class TestForceCloseConfirm(unittest.TestCase):
    """§5.23 explicit confirm: the warning arms a token, the next scan spends it."""

    def setUp(self):
        # These drive the second badge immediately; the dead-front has its own test.
        patcher = patch("client.CONFIRM_DEADFRONT_SECONDS", 0)
        patcher.start()
        self.addCleanup(patcher.stop)

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
        self.assertIsNone(state.take_confirm(7))
        state.arm_confirm(7, "tok", 15)
        self.assertIsNone(state.take_confirm(5), "another badge must not consume it")
        self.assertEqual(state.take_confirm(7), "tok")
        self.assertIsNone(state.take_confirm(7), "a spent token must not confirm twice")
        state.arm_confirm(7, "tok", 0)  # countdown already over
        self.assertIsNone(state.take_confirm(7), "an expired countdown confirms nothing")

    def test_a_double_read_inside_the_dead_front_is_dropped(self):
        """A scanner reading the checkout badge twice must not confirm the close
        (online or offline), nor toggle the keyholder back IN."""
        state = AttendanceState()
        state.push_event = lambda event: None
        backend = Mock(attendance_path=None)
        state.arm_confirm(7, "tok-1", 15)
        state.arm_local_close(9, 15)
        outbox = Outbox(":memory:")

        with patch("client.CONFIRM_DEADFRONT_SECONDS", 1.0):
            handle_scan(backend, state, outbox, 7)
            handle_scan(backend, state, outbox, 9)

        backend.post_scan.assert_not_called()
        self.assertEqual(outbox.pending_rows(), [])
        state.confirm_armed_at -= 2
        self.assertEqual(state.take_confirm(7), "tok-1", "still armed for the real second badge")

    def test_another_badge_during_the_countdown_scans_normally(self):
        """A member arriving while a keyholder's close offer counts down is an
        ordinary IN -- never pinned OUT with the keyholder's token."""
        state = AttendanceState()
        state.push_event = lambda event: None
        state.arm_confirm(7, "tok-1", 15)
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"type": "checkin", "participant": {"id": 5}}, 200, None)

        handle_scan(backend, state, Outbox(":memory:"), 5)

        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "IN")
        self.assertIsNone(backend.post_scan.call_args.kwargs["force_close_token"])
        self.assertEqual(state.take_confirm(7), "tok-1", "the keyholder's confirm survives")

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

    def test_checkout_close_offer_arms_the_countdown_and_the_next_scan_closes_as_out(self):
        """Another keyholder is still recorded inside: the checkout goes through
        and offers the close. The second badge echoes the token as OUT."""
        state = AttendanceState()
        events = []
        state.push_event = events.append
        state.present_ids.add(7)
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({
            "type": "checkout", "message": "Checked out successfully",
            "participant": {"id": 7, "name": "Kim"},
            "closePrompt": "Others are still recorded inside. Badge again within 15 seconds to close the building.",
            "forceCloseToken": "tok-offer", "confirmSeconds": 15,
        }, 200, None)

        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertEqual(events[0]["countdown"], 15)
        self.assertIn("CHECKED OUT", events[0]["html"])
        self.assertIn("close the building", events[0]["html"])
        self.assertIn("banner-warning", events[0]["html"])

        backend.post_scan.return_value = ({
            "type": "checkout", "message": "Facility closed", "facilityClosed": True,
            "participant": {"id": 7, "name": "Kim"},
        }, 200, None)
        handle_scan(backend, state, Outbox(":memory:"), 7)

        self.assertEqual(backend.post_scan.call_args.kwargs["intent"], "OUT")
        self.assertEqual(backend.post_scan.call_args.kwargs["force_close_token"], "tok-offer")

    def test_a_queued_confirm_carries_its_token_into_the_outbox(self):
        """Without this the drain replays token-less and the server parks the
        close for review -- silently undoing the confirm the keyholder gave."""
        state = AttendanceState()
        state.push_event = lambda event: None
        state.arm_confirm(7, "tok-1", 15)
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
        state.arm_confirm(7, "tok-2", 15)
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

    def test_skips_when_the_building_is_known_empty(self):
        backend = Mock(attendance_path="/api/attendance")
        backend.get_attendance.return_value = ({"counts": {"total": 0}}, 200)
        state = AttendanceState()
        state.current_counts = {"total": 0}
        state.counts_known = True
        calls = {"n": 0}

        def fake_sleep(_secs):
            calls["n"] += 1
            if calls["n"] >= 2:
                raise _StopLoop()

        with self.assertRaises(_StopLoop):
            attendance_poller(backend, state, sleep_fn=fake_sleep,
                               in_closed_window_fn=lambda: False)
        backend.get_attendance.assert_not_called()

    def test_unknown_occupancy_still_polls_during_the_day(self):
        backend = Mock(attendance_path="/api/attendance")
        backend.get_attendance.return_value = ({"counts": {"total": 0}}, 200)
        state = AttendanceState()
        self.assertFalse(state.counts_known)
        calls = {"n": 0}

        def fake_sleep(_secs):
            calls["n"] += 1
            if calls["n"] >= 2:
                raise _StopLoop()

        with self.assertRaises(_StopLoop):
            attendance_poller(backend, state, sleep_fn=fake_sleep,
                               in_closed_window_fn=lambda: False)
        backend.get_attendance.assert_called()


class TestProxyKeepaliveSkip(unittest.TestCase):
    """Iframe polls /api/attendance every 60s with idleStopMs unset. The proxy
    must swallow those GETs overnight and when empty or ALB never goes quiet."""

    def test_skips_attendance_get_overnight(self):
        state = AttendanceState()
        self.assertTrue(
            skip_kiosk_keepalive(state, "GET", "/api/attendance",
                                 in_closed_window_fn=lambda: True)
        )

    def test_forwards_certs_get_when_known_empty_during_the_day(self):
        """Display-only / other-entrance occupancy comes back on this GET."""
        state = AttendanceState()
        state.counts_known = True
        state.current_counts = {"total": 0}
        self.assertFalse(
            skip_kiosk_keepalive(state, "GET", "/api/kioskdisplay/certifications",
                                 in_closed_window_fn=lambda: False)
        )

    def test_forwards_scan_posts(self):
        state = AttendanceState()
        self.assertFalse(
            skip_kiosk_keepalive(state, "POST", "/api/scan",
                                 in_closed_window_fn=lambda: True)
        )

    def test_forwards_when_occupied(self):
        state = AttendanceState()
        state.counts_known = True
        state.current_counts = {"total": 3}
        self.assertFalse(
            skip_kiosk_keepalive(state, "GET", "/api/attendance",
                                 in_closed_window_fn=lambda: False)
        )

    def test_synthetic_attendance_body_is_json_the_iframe_parses(self):
        body = json.loads(synthetic_keepalive_body("/api/attendance", AttendanceState()))
        self.assertEqual(body["access"], "full")
        self.assertEqual(body["counts"]["youth"], 0)
        self.assertEqual(body["safety"], {"isLastKeyholder": False, "isTwoDeepViolation": False})
        self.assertEqual(body["attendance"], [])


class TestOfflineForceClose(unittest.TestCase):
    """Offline the server mints no token, so the kiosk runs the last-keyholder
    warning + two-scan confirm itself and flags the queued close as confirmed."""

    def setUp(self):
        # These drive the second badge immediately; the dead-front has its own test.
        patcher = patch("client.CONFIRM_DEADFRONT_SECONDS", 0)
        patcher.start()
        self.addCleanup(patcher.stop)

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
        self.assertTrue(state.offline_close_offer(9))
        self.assertFalse(state.offline_close_offer(5), "a non-keyholder never closes the building")

    def test_close_offered_when_another_keyholder_is_recorded_inside(self):
        # The other keyholder may be a forgotten badge-out: any keyholder can close.
        state = self._state()
        state.keyholder_ids = {9, 3}
        state.current_counts = {"keyholders": 2, "total": 3}
        self.assertTrue(state.offline_close_offer(9))

    def test_no_close_offer_for_a_keyholder_alone(self):
        state = self._state()
        state.current_counts = {"keyholders": 1, "total": 1}
        self.assertFalse(state.offline_close_offer(9))

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
        self.assertIn("badge again to close", events[-1]["html"].lower())
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
