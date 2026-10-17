#!/usr/bin/env python3
"""Simulate a badge scan by sending a signed POST to the backend.

Usage:
    ./badge.py <participant_id>
    ./badge.py 5
"""

import json
import os
import sys
import requests

# Signing is shared with the kiosk proxy so the two entry points can't drift.
from client import load_signing_key, sign_request


def load_config(path="config.json"):
    if not os.path.exists(path):
        print(f"Error: {path} not found. Copy config.example.json → config.json")
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def main():
    if len(sys.argv) != 2:
        print("Usage: ./badge.py <participant_id>")
        sys.exit(1)

    try:
        participant_id = int(sys.argv[1])
    except ValueError:
        print(f"Error: '{sys.argv[1]}' is not a valid integer ID")
        sys.exit(1)

    config = load_config()
    base_url = config["backend_url"].rstrip("/")
    key_path = config.get("private_key_path", "./client.key")

    if not os.path.exists(key_path):
        print(f"Error: private key not found at {key_path}")
        print("Run: python generate_keys.py")
        sys.exit(1)

    signing_key = load_signing_key(key_path)

    path = "/api/scan"
    body = json.dumps({"participantId": participant_id})
    headers = sign_request(signing_key, "POST", path, body)
    headers["Content-Type"] = "application/json"

    url = base_url + path
    print(f"POST {url}")
    print(f"  participantId: {participant_id}")

    r = requests.post(url, headers=headers, data=body, timeout=10)
    data = r.json()

    if r.status_code >= 400:
        print(f"  ✗ {r.status_code}: {data.get('error', data)}")
    else:
        scan_type = data.get("type", "?").upper()
        email = data.get("participant", {}).get("email", "?")
        print(f"  ✓ {scan_type} — {email}")

        if data.get("facilityClosed"):
            print("  ⚠ Facility closed!")


if __name__ == "__main__":
    main()
