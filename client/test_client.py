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
    KioskHandler,
    _scan_result_banner_html,
    ping_poller,
    handle_scan,
    local_clock_label,
    latest_release_tag,
    main,
    resolve_update_target,
)


class _StopLoop(Exception):
    """Sentinel to escape ping_poller's `while True` in tests."""


def scan_banner(body, status=200):
    return _scan_result_banner_html(body, status)


class TestLocalClockReadout(unittest.TestCase):
    """The door screen shows the Pi's clock as Python sees it, so a Pi on the
    wrong timezone is visible at a glance."""

    CDT = timezone(timedelta(hours=-5), "CDT")

    def test_label_carries_time_zone_name_and_offset(self):
        self.assertEqual(local_clock_label(datetime(2026, 10, 7, 14, 5, tzinfo=self.CDT)),
                         "14:05 CDT (UTC-0500)")

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
    still confirms the scan — in amber."""

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


class TestServerClosedTheFacility(unittest.TestCase):
    """The server decides a close and says so in the scan response; the kiosk
    only reports it."""

    BODY = {"type": "checkout", "facilityClosed": True, "participant": {"name": "Sam"},
            "message": "Checked out and Facility closed"}

    def test_the_banner_passes_on_the_servers_close(self):
        self.assertIn(CLOSING_ALONE_COPY, scan_banner(self.BODY))

    def test_an_ordinary_checkout_says_nothing_about_closing(self):
        self.assertNotIn(CLOSING_ALONE_COPY, scan_banner({**self.BODY, "facilityClosed": False}))


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

    def test_a_closed_facility_park_is_still_not_green(self):
        html_out = scan_banner({
            "type": "parked",
            "reason": "facility_closed",
            "message": "Recorded. Will project when a keyholder is present.",
        })

        self.assertIn("banner-warning", html_out)
        self.assertNotIn("banner-ok", html_out)


class TestBackendClient(unittest.TestCase):
    def test_required_methods_exist(self):
        """Ensure BackendClient has the necessary structural methods."""
        client = BackendClient("http://fake", "fake_key")

        self.assertTrue(hasattr(client, "post_scan"), "BackendClient is missing post_scan method")
        self.assertTrue(hasattr(client, "get_attendance"), "BackendClient is missing get_attendance method")
        self.assertTrue(hasattr(client, "_headers"), "BackendClient is missing _headers method")


class TestScanBodyIsJustTheBadge(unittest.TestCase):
    """The kiosk reports the badge and nothing else: the server owns the
    direction, the close and every other consequence."""

    def _post(self, status=200, body=None):
        client = BackendClient("http://fake", SigningKey(b"\x00" * 32))
        client.session = MagicMock()
        client.session.post.return_value = MagicMock(
            status_code=status, headers={}, json=lambda: body if body is not None else {}
        )
        result = client.post_scan(7)
        return json.loads(client.session.post.call_args.kwargs["data"]), result

    def test_the_payload_is_only_the_participant_id(self):
        payload, _ = self._post()
        self.assertEqual(payload, {"participantId": 7})

    def test_an_unreadable_body_is_not_a_recorded_scan(self):
        client = BackendClient("http://fake", SigningKey(b"\x00" * 32))
        client.session = MagicMock()
        unreadable = MagicMock(status_code=503, headers={})
        unreadable.json.side_effect = ValueError("not json")
        client.session.post.return_value = unreadable

        body, status = client.post_scan(7)

        self.assertEqual(status, 503)
        self.assertIn("not recorded", body["error"])
        self.assertIn("banner-error", _scan_result_banner_html(body, status))

    def test_the_ping_returns_the_whole_body_and_status(self):
        """The ping carries the deploy version and, for a verified kiosk, the
        building state the server already holds."""
        client = BackendClient("http://fake", "fake_key")
        answer = {"version": "abc", "facility": {"open": False, "rosterGeneration": 4}}
        with patch.object(BackendClient, "_headers", return_value={}), \
             patch.object(client.session, "get") as get:
            get.return_value = Mock(status_code=200, json=Mock(return_value=answer))
            self.assertEqual(client.get_ping(), (answer, 200))

    def test_the_ping_is_signed_so_the_server_will_answer_with_the_building(self):
        client = BackendClient("http://fake", SigningKey(b"\x00" * 32))
        client.session = MagicMock()
        client.session.get.return_value = MagicMock(status_code=200, json=lambda: {})
        client.get_ping()
        headers = client.session.get.call_args.kwargs["headers"]
        self.assertIn("X-Kiosk-Signature", headers)
        self.assertIn("X-Kiosk-Nonce", headers)

    def test_an_unreachable_ping_is_an_empty_answer(self):
        client = BackendClient("http://fake", "fake_key")
        with patch.object(BackendClient, "_headers", return_value={}), \
             patch.object(client.session, "get", side_effect=OSError("down")):
            self.assertEqual(client.get_ping(), ({}, 0))


class TestHandleScan(unittest.TestCase):
    """One badge, one POST, one banner."""

    def _state(self):
        state = AttendanceState()
        self.events = []
        state.push_event = self.events.append
        return state

    def _backend(self, body=None, status=200):
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = (body or {"type": "checkin", "participant": {"id": 7, "name": "Bo"}},
                                          status)
        return backend

    def test_a_scan_is_sent_and_confirmed(self):
        state = self._state()
        backend = self._backend()

        handle_scan(backend, state, 7)

        backend.post_scan.assert_called_once_with(7)
        self.assertIn("✓ Bo — CHECKED IN", self.events[-1]["html"])

    def test_an_unreachable_server_is_a_failed_scan(self):
        """Nothing is stored and nothing is retried: the screen says the scan
        did not land, so the person at the door knows to try again."""
        state = self._state()
        backend = self._backend({"error": "Connection refused"}, 0)

        handle_scan(backend, state, 7)

        self.assertIn("banner-error", self.events[-1]["html"])
        self.assertIn("Connection refused", self.events[-1]["html"])

    def test_a_malformed_read_is_never_sent(self):
        state = self._state()
        backend = self._backend()

        for bad in ("", "12x", "99999999999", "0", "٧"):
            with self.subTest(bad=bad):
                handle_scan(backend, state, bad)

        backend.post_scan.assert_not_called()
        self.assertIn("Badge not read", self.events[-1]["html"])

    def test_a_recorded_scan_refreshes_the_board(self):
        state = self._state()
        backend = self._backend()
        backend.attendance_path = "/api/attendance"
        roster = {"attendance": [], "counts": {"total": 1}, "safety": {"isLastKeyholder": False}}
        backend.get_attendance.return_value = (roster, 200)

        handle_scan(backend, state, 7)

        self.assertEqual(self.events[-1], {"html": "", **roster})
        self.assertEqual(state.current_counts, {"total": 1})

    def test_a_failed_scan_does_not_refetch_the_roster(self):
        state = self._state()
        backend = self._backend({"error": "Connection refused"}, 0)
        backend.attendance_path = "/api/attendance"

        handle_scan(backend, state, 7)

        backend.get_attendance.assert_not_called()


class TestRepeatReadFilter(unittest.TestCase):
    """Reads of one badge within REPEAT_READ_SECONDS are one scan, filtered at
    the reader before anything is sent."""

    def setUp(self):
        self.now = 1000.0
        patcher = patch("client.time.monotonic", lambda: self.now)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.state = AttendanceState()
        self.state.push_event = lambda event: None

    def _backend(self):
        backend = Mock(attendance_path=None)
        backend.post_scan.return_value = ({"type": "checkin", "participant": {"id": 7}}, 200)
        return backend

    def test_double_read_is_one_scan(self):
        backend = self._backend()
        handle_scan(backend, self.state, 7)
        self.now += 2.9
        handle_scan(backend, self.state, 7)
        self.assertEqual(backend.post_scan.call_count, 1)

    def test_the_window_slides_while_the_badge_is_held(self):
        backend = self._backend()
        handle_scan(backend, self.state, 7)
        for _ in range(4):                                 # held 8 s, read every 2 s
            self.now += 2.0
            handle_scan(backend, self.state, 7)
        self.assertEqual(backend.post_scan.call_count, 1, "a held badge is one scan")
        self.now += 3.0                                    # lifted, then badged again
        handle_scan(backend, self.state, 7)
        self.assertEqual(backend.post_scan.call_count, 2)

    def test_two_scans_four_seconds_apart_both_go(self):
        backend = self._backend()
        handle_scan(backend, self.state, 7)
        self.now += 4
        handle_scan(backend, self.state, 7)
        self.assertEqual(backend.post_scan.call_count, 2)

    def test_other_badges_are_not_filtered(self):
        backend = self._backend()
        handle_scan(backend, self.state, 7)
        handle_scan(backend, self.state, 8)
        self.assertEqual(backend.post_scan.call_count, 2)

    def test_a_filtered_read_shows_nothing(self):
        events = []
        self.state.push_event = events.append
        backend = self._backend()
        handle_scan(backend, self.state, 7)
        self.now += 1
        handle_scan(backend, self.state, 7)
        self.assertEqual(len(events), 1)


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


class TestPingPoller(unittest.TestCase):
    """The kiosk asks once a second what changed and fetches the roster only
    when the server says its roster moved. Whether that costs the server a
    query — and so whether the database wakes — is the server's call."""

    ROSTER = {"attendance": [], "counts": {"total": 0}, "safety": {"isLastKeyholder": False}}

    def setUp(self):
        self.now = 10_000.0
        patcher = patch("client.time.monotonic", lambda: self.now)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.state = AttendanceState()
        self.pushed = []
        self.state.push_event = self.pushed.append

    def _backend(self, pings, attendance_path="/api/attendance"):
        backend = Mock(attendance_path=attendance_path)
        backend.get_ping.side_effect = list(pings)
        backend.get_attendance.return_value = (self.ROSTER, 200)
        return backend

    def _run(self, backend, pings, advance=0.0):
        calls = {"n": 0}

        def fake_sleep(_secs):
            calls["n"] += 1
            self.now += advance
            if calls["n"] > len(pings):
                raise _StopLoop()

        with self.assertRaises(_StopLoop):
            ping_poller(backend, self.state, sleep_fn=fake_sleep)

    @staticmethod
    def _ping(generation, open_=False, version="v1"):
        return ({"version": version,
                 "facility": {"open": open_, "rosterGeneration": generation}}, 200)

    def test_the_first_ping_fetches_the_roster(self):
        pings = [self._ping(3)]
        backend = self._backend(pings)

        self._run(backend, pings)

        backend.get_attendance.assert_called_once()
        self.assertEqual(self.pushed, [{"html": "", **self.ROSTER}])

    def test_an_unmoved_generation_fetches_nothing_further(self):
        pings = [self._ping(3)] * 3
        backend = self._backend(pings)

        self._run(backend, pings)

        backend.get_attendance.assert_called_once()

    def test_a_moved_generation_fetches_again(self):
        pings = [self._ping(3, open_=True), self._ping(4, open_=True)]
        backend = self._backend(pings)

        self._run(backend, pings)

        self.assertEqual(backend.get_attendance.call_count, 2)

    def test_a_closed_building_is_not_refetched_however_long_it_waits(self):
        """The whole point: a kiosk pinging a closed building asks the server
        for nothing it would have to query for."""
        pings = [self._ping(3)] * 4
        backend = self._backend(pings)

        self._run(backend, pings, advance=60.0)

        backend.get_attendance.assert_called_once()

    def test_an_open_building_refreshes_on_the_fallback_cadence(self):
        pings = [self._ping(3, open_=True)] * 3
        backend = self._backend(pings)

        self._run(backend, pings, advance=60.0)

        self.assertEqual(backend.get_attendance.call_count, 3)

    def test_without_a_facility_block_it_polls_on_the_fallback_only(self):
        for advance, expected in ((0.0, 1), (60.0, 3)):
            with self.subTest(advance=advance):
                pings = [({"version": "v1"}, 200)] * 3
                backend = self._backend(pings)
                self.state.push_event = lambda event: None
                self._run(backend, pings, advance=advance)
                self.assertEqual(backend.get_attendance.call_count, expected)

    def test_a_new_server_version_asks_the_board_to_reload(self):
        pings = [self._ping(1, version="v1"), self._ping(1, version="v2")]
        backend = self._backend(pings)

        self._run(backend, pings)

        self.assertIn({"reload": True}, self.pushed)

    def test_the_first_version_seen_is_not_a_change(self):
        pings = [self._ping(1, version="v1")]
        backend = self._backend(pings)

        self._run(backend, pings)

        self.assertNotIn({"reload": True}, self.pushed)

    def test_an_unreachable_server_changes_nothing(self):
        pings = [({}, 0)] * 3
        backend = self._backend(pings)

        self._run(backend, pings, advance=60.0)

        backend.get_attendance.assert_not_called()
        self.assertEqual(self.pushed, [])

    def test_the_version_is_watched_even_with_no_roster_configured(self):
        pings = [self._ping(1, version="v1"), self._ping(1, version="v2")]
        backend = self._backend(pings, attendance_path=None)

        self._run(backend, pings)

        backend.get_attendance.assert_not_called()
        self.assertIn({"reload": True}, self.pushed)


class TestProxyPassesEverythingThrough(unittest.TestCase):
    """The proxy signs and relays. It never answers a board request itself, and
    it never serves a roster the server did not send."""

    def _proxy(self, method="GET", path="/api/attendance", upstream_body=b"", status=200, error=None):
        state = AttendanceState()
        handler = KioskHandler.__new__(KioskHandler)
        handler.path = path
        handler.headers = {}
        handler.state = state
        handler.backend = Mock(base_url="http://backend", signing_key=SigningKey.generate())
        handler.wfile = io.BytesIO()
        handler.rfile = io.BytesIO(b"")
        handler.send_response = Mock()
        handler.send_header = handler.end_headers = Mock()
        resp = Mock(status_code=status, headers={})
        resp.iter_content.return_value = [upstream_body]
        upstream = patch("client.requests.request", side_effect=error) if error else \
            patch("client.requests.request", return_value=resp)
        with upstream:
            handler._proxy_request(method)
        return handler, state

    def test_every_roster_get_reaches_the_server(self):
        roster = b'{"access": "full", "attendance": [], "counts": {"total": 0}}'
        handler, _ = self._proxy(upstream_body=roster)
        handler.send_response.assert_called_once_with(200)
        self.assertEqual(handler.wfile.getvalue(), roster)

    def test_repeated_gets_are_all_forwarded(self):
        empty = b'{"access": "full", "attendance": [], "counts": {"total": 0}}'
        for _ in range(3):
            handler, _ = self._proxy(upstream_body=empty)
            handler.send_response.assert_called_once_with(200)

    def test_an_unreachable_server_answers_502_not_a_kiosk_roster(self):
        handler, _ = self._proxy(error=ConnectionError("down"))
        handler.send_response.assert_called_once_with(502)
        self.assertEqual(handler.wfile.getvalue(), b"")

    def test_a_served_roster_marks_the_browser_and_the_server_alive(self):
        _, state = self._proxy(upstream_body=b"{}")
        self.assertIsNotNone(state.last_attendance_ok)
        self.assertFalse(state.attendance_auth_fail)

    def test_a_rejected_signature_is_recorded_for_the_health_monitor(self):
        _, state = self._proxy(status=401)
        self.assertTrue(state.attendance_auth_fail)


if __name__ == "__main__":
    unittest.main()
