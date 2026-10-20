"""The kiosk's git-free build identity.

The point of the digest is that it answers "are these two Pis running the same
bytes?" without git, so these tests work on a temp directory standing in for a
checkout rather than on the real one.
"""

import os
import tempfile
import unittest
from unittest.mock import patch

from version import (
    UNKNOWN,
    content_digest,
    declared_version,
    kiosk_version,
)


def build(tmp, files, version="1.2.3"):
    """Write a stand-in checkout and return its path."""
    if version is not None:
        with open(os.path.join(tmp, "VERSION"), "w") as f:
            f.write(version + "\n")
    for name, body in files.items():
        with open(os.path.join(tmp, name), "w") as f:
            f.write(body)
    return tmp


class TestDeclaredVersion(unittest.TestCase):
    def test_reads_the_version_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(declared_version(build(tmp, {})), "1.2.3")

    def test_missing_file_is_unknown_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(declared_version(tmp), UNKNOWN)

    def test_strips_characters_that_could_forge_a_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            build(tmp, {}, version="1.2.3\r\nX-Evil: 1")
            self.assertEqual(declared_version(tmp), "1.2.3X-Evil1")

    def test_caps_the_length(self):
        with tempfile.TemporaryDirectory() as tmp:
            build(tmp, {}, version="9" * 200)
            self.assertEqual(len(declared_version(tmp)), 64)


class TestContentDigest(unittest.TestCase):
    def test_same_bytes_give_the_same_digest(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            files = {"client.py": "print(1)\n", "kiosk.sh": "echo hi\n"}
            self.assertEqual(
                content_digest(build(a, files)), content_digest(build(b, files))
            )

    def test_an_edited_file_moves_the_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            before = content_digest(build(tmp, {"client.py": "print(1)\n"}))
            after = content_digest(build(tmp, {"client.py": "print(2)\n"}))
            self.assertNotEqual(before, after)

    def test_a_rename_alone_moves_the_digest(self):
        """Names are hashed with the bytes, so moving code between files shows."""
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            one = content_digest(build(a, {"client.py": "x\n"}))
            other = content_digest(build(b, {"health.py": "x\n"}))
            self.assertNotEqual(one, other)

    def test_per_pi_state_is_not_part_of_identity(self):
        """config.json, the key and the outbox differ per Pi; the digest must not."""
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            files = {"client.py": "x\n"}
            build(a, files)
            build(b, dict(files, **{"config.json": '{"usb_device":"other"}'}))
            with open(os.path.join(b, "outbox.db"), "w") as f:
                f.write("junk")
            self.assertEqual(content_digest(a), content_digest(b))

    def test_unreadable_directory_is_unknown_not_an_error(self):
        with patch("version.os.listdir", side_effect=OSError("boom")):
            self.assertEqual(content_digest("/nonexistent"), UNKNOWN)


class TestKioskVersion(unittest.TestCase):
    def test_combines_declared_and_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            build(tmp, {"client.py": "x\n"})
            declared, _, digest = kiosk_version(tmp).partition("+")
            self.assertEqual(declared, "1.2.3")
            self.assertEqual(len(digest), 12)

    def test_reports_unknown_rather_than_raising_on_a_broken_checkout(self):
        self.assertEqual(kiosk_version("/nonexistent"), f"{UNKNOWN}+{UNKNOWN}")

    def test_the_real_checkout_resolves_both_halves(self):
        """Guards against shipping a kiosk that reports unknown+unknown."""
        declared, _, digest = kiosk_version().partition("+")
        self.assertNotEqual(declared, UNKNOWN)
        self.assertNotEqual(digest, UNKNOWN)


if __name__ == "__main__":
    unittest.main()
