"""The local health check and what the container image relies on."""

import json
import os
import re
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import client
import health
import healthcheck
from client import AttendanceState, KioskHandler, usb_scanner_listener, version_poller
from outbox import Outbox

HERE = os.path.dirname(os.path.abspath(__file__))


class _Stop(Exception):
    """Escapes a daemon loop's `while True`."""


class TestLocalHealth(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.state = AttendanceState()
        self.state.scanner_held = True
        self.outbox = Outbox(os.path.join(self.dir.name, "outbox.db"))
        self.backend = MagicMock()
        for name, value in (("state", self.state), ("outbox", self.outbox), ("backend", self.backend)):
            patcher = patch.object(KioskHandler, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), KioskHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.config = os.path.join(self.dir.name, "config.json")
        self._write_config(self.server.server_address[1])

    def _write_config(self, port):
        with open(self.config, "w") as f:
            json.dump({"listen_port": port}, f)

    def test_healthy_without_contacting_the_server(self):
        with patch("requests.sessions.Session.request") as send:
            self.assertEqual(healthcheck.check(self.config), [])
        send.assert_not_called()
        self.assertEqual(self.backend.mock_calls, [])

    def test_probe_does_not_count_as_the_browser(self):
        self.state.last_browser_seen = 0
        healthcheck.check(self.config)
        self.assertEqual(self.state.last_browser_seen, 0)

    def test_scanner_not_held_fails(self):
        self.state.scanner_held = False
        self.assertEqual(healthcheck.check(self.config), ["scanner"])

    def test_database_failure_fails(self):
        self.outbox._conn.close()
        self.assertEqual(healthcheck.check(self.config), ["database"])

    def test_proxy_down_fails(self):
        self.server.shutdown()
        self.server.server_close()
        failed = healthcheck.check(self.config)
        self.assertEqual(len(failed), 1)
        self.assertTrue(failed[0].startswith("proxy"))

    def test_missing_config_fails(self):
        self.assertTrue(healthcheck.check(os.path.join(self.dir.name, "absent.json")))


class TestScannerHeld(unittest.TestCase):
    def test_starts_not_held(self):
        self.assertFalse(AttendanceState().scanner_held)

    def test_missing_evdev_is_not_held_and_shows_disconnected(self):
        state = AttendanceState()
        with patch.dict(sys.modules, {"evdev": None}):
            usb_scanner_listener(MagicMock(), state, MagicMock(), "Scanner")
        self.assertFalse(state.scanner_held)
        self.assertFalse(state.scanner_ok)

    def test_grab_holds_and_loss_releases(self):
        state = AttendanceState()
        device = MagicMock(path="/dev/input/event0")
        device.name = "Scanner"
        held_while_reading = []

        def unplugged():
            held_while_reading.append(state.scanner_held)
            raise OSError("unplugged")

        device.read_loop.side_effect = unplugged
        evdev = MagicMock()
        evdev.list_devices.return_value = ["/dev/input/event0"]
        evdev.InputDevice.return_value = device
        with patch.dict(sys.modules, {"evdev": evdev}), \
                patch("client.time.sleep", side_effect=_Stop), \
                self.assertRaises(_Stop):
            usb_scanner_listener(MagicMock(), state, MagicMock(), "Scanner")
        device.grab.assert_called_once()
        self.assertEqual(held_while_reading, [True])
        self.assertFalse(state.scanner_held)

    def test_no_matching_device_is_not_held(self):
        state = AttendanceState()
        evdev = MagicMock()
        evdev.list_devices.return_value = []
        with patch.dict(sys.modules, {"evdev": evdev}), \
                patch("client.time.sleep", side_effect=_Stop), \
                self.assertRaises(_Stop):
            usb_scanner_listener(MagicMock(), state, MagicMock(), "Scanner")
        self.assertFalse(state.scanner_held)


class TestContainerRuntime(unittest.TestCase):
    def test_container_skips_git_self_update(self):
        backend = MagicMock()
        backend.get_server_version.return_value = ("v1", 2, 200)
        with patch.dict(os.environ, {"KIOSK_CONTAINER": "1"}), \
                patch("client.kiosk_quiet", return_value=True), \
                patch("client.time.sleep", side_effect=[None, _Stop()]), \
                patch("client.subprocess.run") as run, \
                patch("client.subprocess.check_output") as check_output, \
                self.assertRaises(_Stop):
            version_poller(backend, MagicMock(), MagicMock())
        run.assert_not_called()
        check_output.assert_not_called()

    def test_chromium_marker_lands_in_the_working_directory(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as d:
            os.chdir(d)
            try:
                self.assertTrue(health._write_sentinel())
                self.assertTrue(os.path.exists(os.path.join(d, ".chromium-bounce")))
            finally:
                os.chdir(previous)

    def test_outbox_defaults_to_a_relative_path(self):
        self.assertFalse(os.path.isabs(client.DEFAULT_OUTBOX_PATH))


class TestDockerfile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, "Dockerfile")) as f:
            cls.dockerfile = f.read()

    def test_copies_only_named_source_files(self):
        lines = re.findall(r"^COPY (?!--from)(.+)$", self.dockerfile, re.MULTILINE)
        sources = [src for line in lines for src in line.split()[:-1]]
        self.assertIn("client.py", sources)
        for src in sources:
            self.assertRegex(src, r"^[a-z_]+\.(py|txt)$")

    def test_final_working_directory_is_data(self):
        self.assertEqual(re.findall(r"^WORKDIR (.+)$", self.dockerfile, re.MULTILINE)[-1], "/data")

    def test_requirements_pin_evdev(self):
        with open(os.path.join(HERE, "requirements.txt")) as f:
            self.assertRegex(f.read(), r"(?m)^evdev==\d")


if __name__ == "__main__":
    unittest.main()
