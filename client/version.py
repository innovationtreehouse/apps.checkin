"""Kiosk build identity, resolved without git.

The Pi cannot assume git is on PATH at run time, so the version the kiosk
reports is read off the filesystem as two values:

  * VERSION -- the release this checkout declares. Human-readable and
    orderable, but only as honest as the last bump.
  * a content digest over the files the kiosk executes. Ground truth: two Pis
    agreeing on it are running identical bytes, and a half-applied update or an
    edit made on the Pi moves it even when VERSION stands still.

Both are resolved once and cached: every signed request carries the result, so
it must cost nothing per request. Neither raises -- a kiosk that cannot read
its own files still has to serve scans.
"""

import hashlib
import os
import string

UNKNOWN = "unknown"

VERSION_FILE = "VERSION"

# Suffixes whose bytes define a build. config.json, client.key, the outbox and
# the self-update stamp are per-Pi state, not identity -- digesting them would
# give every Pi a different answer.
BUILD_SUFFIXES = (".py", ".sh", ".txt")

DIGEST_CHARS = 12
MAX_VERSION_CHARS = 64

# Header-safe subset. A hand-edited VERSION must not be able to inject a header
# or an unbounded log line on the server that records it.
_ALLOWED = frozenset(string.ascii_letters + string.digits + "._-+")

_cached = None


def _build_dir():
    return os.path.dirname(os.path.abspath(__file__))


def _sanitize(text):
    return "".join(c for c in text if c in _ALLOWED)[:MAX_VERSION_CHARS]


def declared_version(build_dir=None):
    """The release VERSION claims, or "unknown"."""
    path = os.path.join(build_dir or _build_dir(), VERSION_FILE)
    try:
        with open(path) as f:
            return _sanitize(f.read().strip()) or UNKNOWN
    except OSError:
        return UNKNOWN


def content_digest(build_dir=None):
    """Short digest over the build files, or "unknown" if they can't be read.

    Each file's name is hashed alongside its bytes, so adding or renaming one
    moves the digest even when no line of code changed.
    """
    root = build_dir or _build_dir()
    digest = hashlib.sha256()
    try:
        names = sorted(
            name for name in os.listdir(root)
            if name.endswith(BUILD_SUFFIXES)
            and os.path.isfile(os.path.join(root, name))
        )
        for name in names:
            with open(os.path.join(root, name), "rb") as f:
                digest.update(name.encode())
                digest.update(b"\0")
                digest.update(hashlib.sha256(f.read()).digest())
    except OSError:
        return UNKNOWN
    return digest.hexdigest()[:DIGEST_CHARS]


def kiosk_version(build_dir=None):
    """`<declared>+<digest>` -- the one value every request reports.

    Cached for the default build dir only, so a test passing an explicit
    directory always recomputes.
    """
    global _cached
    if build_dir is None and _cached is not None:
        return _cached
    value = f"{declared_version(build_dir)}+{content_digest(build_dir)}"
    if build_dir is None:
        _cached = value
    return value
