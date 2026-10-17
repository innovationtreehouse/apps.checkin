"""Pin the kiosk->server Ed25519 signing contract to a golden vector.

kiosk-signing-vector.test.json is read by this suite AND by the server's
verifyKioskSignature test, so a change to the message template, a header name,
or the signature encoding turns one side red instead of silently breaking every
deployed kiosk. The fixture's key is test-only — see its `_security` field.
"""

import json
import os
import unittest

from nacl.signing import SigningKey

import badge
import client
from client import build_signed_message, sign_request

VECTOR_PATH = os.path.join(os.path.dirname(__file__), "kiosk-signing-vector.test.json")

with open(VECTOR_PATH) as f:
    VECTOR = json.load(f)

TEST_ONLY_KEY = SigningKey(bytes.fromhex(VECTOR["test_only_private_key_seed_hex"]))


class TestSigningVector(unittest.TestCase):
    def test_signature_matches_golden_vector(self):
        """The message template + hex encoding still produce the pinned signature."""
        message = build_signed_message(
            VECTOR["timestamp"],
            VECTOR["nonce"],
            VECTOR["method"],
            VECTOR["path"],
            VECTOR["body"],
        )
        signature = TEST_ONLY_KEY.sign(message).signature.hex()
        self.assertEqual(signature, VECTOR["expected_signature_hex"])

    def test_public_key_matches_the_fixture_seed(self):
        """The fixture's public key is the one the server test verifies against."""
        self.assertEqual(
            TEST_ONLY_KEY.verify_key.encode().hex(), VECTOR["test_only_public_key_hex"]
        )

    def test_sign_request_emits_the_contract_headers(self):
        """sign_request signs via the pinned seam and names the three headers."""
        headers = sign_request(TEST_ONLY_KEY, VECTOR["method"], VECTOR["path"], VECTOR["body"])
        h = VECTOR["headers"]
        self.assertEqual(set(headers), {h["timestamp"], h["nonce"], h["signature"]})

        message = build_signed_message(
            headers[h["timestamp"]],
            headers[h["nonce"]],
            VECTOR["method"],
            VECTOR["path"],
            VECTOR["body"],
        )
        self.assertEqual(
            headers[h["signature"]], TEST_ONLY_KEY.sign(message).signature.hex()
        )

    def test_badge_shares_the_client_signing_implementation(self):
        """badge.py must not carry its own copy of the signing code."""
        self.assertIs(badge.sign_request, client.sign_request)


if __name__ == "__main__":
    unittest.main()
