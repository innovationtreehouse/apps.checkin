# CheckMeIn Kiosk Client

A thin Python client for Raspberry Pi that runs at the facility entrance. It acts as a transparent signing proxy — Chromium points at this local server, which injects Ed25519 signature headers and forwards all requests to the remote backend.

## What it does

1. **Transparent signing proxy** — serves on `localhost:8083`, proxies all requests to the backend with Ed25519 signature headers injected automatically
2. **Kiosk display wrapper** — serves an HTML wrapper at `/` that iframes `kiosk_path` (default `/attendance/current?mode=kiosk`) from the backend, with a flash banner overlay for scan feedback
3. **Listens for badge scans** — reads USB barcode/QR scanner input, sends signed POST to `/api/scan`
4. **Scan feedback** — displays check-in/check-out confirmation banners via a polling mechanism

## Setup

```bash
# Install dependencies (system-wide)
sudo apt update
sudo apt install python3-requests python3-nacl python3-evdev
# Color emoji font, so emoji in the web UI render in Chromium instead of empty boxes
sudo apt install fonts-noto-color-emoji

# Generate a keypair (one-time)
python3 generate_keys.py
# → writes client.key (keep on Pi)
# → prints public key hex (paste into backend .env as KIOSK_PUBLIC_KEY)

# Copy and edit config
cp config.example.json config.json
# Edit backend_url, usb_device, etc.
```

## Autostart (Raspberry Pi with LightDM + Openbox)

This section covers the source checkout. For the containerized client, see [host/README.md](host/README.md).

The Pi uses LightDM (graphical display manager) with an Openbox session. The boot flow is:

```
LightDM auto-login → Openbox X session → autostart runs kiosk.sh
```

### Setup steps

1. **Configure LightDM auto-login** — edit `/etc/lightdm/lightdm.conf` and ensure these lines are in the `[Seat:*]` section (replace `pi` with the kiosk user if different). Remove or comment out any other `autologin-session` lines:
   ```ini
   [Seat:*]
   autologin-user=pi
   autologin-session=openbox
   ```

2. **`~/.config/openbox/autostart`** should call `kiosk.sh` (copy from system autostart and modify):
   ```bash
   mkdir -p ~/.config/openbox
   cp /etc/xdg/openbox/autostart ~/.config/openbox/autostart
   ```
   Then edit `~/.config/openbox/autostart` — replace any `chromium-browser`/`chromium` line at the end with:
   ```bash
   # Start kiosk client + Chromium (reads port from config.json)
   cd ~/checkin/client && ./kiosk.sh &
   ```

3. **`/etc/xdg/openbox/autostart`** — comment out any direct `chromium` line (the user autostart overrides it, but both files are sourced):
   ```bash
   #chromium-browser  --noerrdialogs --disable-infobars --enable-offline-auto-reload --kiosk http://127.0.0.1:8089
   ```

> **Note:** Do NOT use `~/.config/autostart/*.desktop` files — Openbox does not process XDG desktop autostart entries.

## Running

```bash
# Development (no USB scanner, reads from stdin)
python3 client.py

# Production (Raspberry Pi with Chromium kiosk)
./kiosk.sh
```

## Tests

```bash
pip install -r requirements.txt
python3 -m unittest discover
```

Run from `client/`. CI runs the same command (the `Kiosk client tests (Python)`
job in `.github/workflows/ci.yml`).

`kiosk-signing-vector.test.json` is a golden vector pinning the Ed25519
request-signing contract: `test_signing_vector.py` reproduces its signature, and
the backend's `verifyKioskSignature` test verifies the same one, so a change to
the message format on either side turns that side red.

> **The key in that fixture is test-only and public.** Never write it to
> `client.key` on a Pi, and never set its public key as `KIOSK_PUBLIC_KEY` on any
> instance — anyone could then forge signed kiosk requests.

### Testing without a scanner

When `usb_device` is empty in `config.json`, the client reads participant IDs from stdin. Just type an ID and press Enter to simulate a scan.

## Configuration

| Key | Description |
|-----|-------------|
| `backend_url` | Full URL to the CheckMeIn backend (e.g. `https://checkmein.example.com`) |
| `private_key_path` | Path to the Ed25519 private key file |
| `usb_device` | Device name or path (e.g. `Newtologic` or `/dev/input/event0`), empty for stdin |
| `listen_port` | Local HTTP server port (default `8083`) |
| `kiosk_path` | Backend path for the kiosk display and initial data fetch (default `/attendance/current?mode=kiosk`) |
| `attendance_path` | Signed `GET` for the live roster (default `/api/attendance`). Empty disables the poller. The kiosk rests while the building is known empty (the last real roster showed nobody, with no badge or on-screen check-in since and nothing queued), at any hour: the roster poll, the server-version check and the dead-letter retry pause, and once each board page has had the real empty roster, the proxy answers its roster `GET`s with `204` and no body. The next badge ends it. Assumes this is the only door scanner. A web check-in into an empty building does not reach the screen until the next badge. |

## Architecture

```
┌─────────────────────┐                    ┌──────────────┐
│  Kiosk Client       │   signed proxy     │   Backend    │
│  localhost:8083     │  ──────────────→   │  (Next.js)   │
│                     │                    │              │
│  GET /              │  serves wrapper    │              │
│  GET kiosk_path     │  ← proxied ──────  │ kiosk_path   │
│  GET /events        │  scan feedback SSE │              │
│  POST /api/scan     │  ← from scanner   │ /api/scan    │
│  * (all other)      │  ← proxied ──────  │              │
│                     │                    │              │
│  USB Scanner ───────│──signed POST──────→│              │
└─────────────────────┘                    └──────────────┘
        ↑                                        ↑
     Chromium                              KIOSK_PUBLIC_KEY
     kiosk mode                             in .env
```

## Files

- `client.py` — Main process (signing proxy server + scan listener + flash overlay)
- `badge.py` — Send one signed scan by hand; reuses `client.py`'s signing
- `scanner_discovery.py` — Manual helper: list USB input devices matching a pattern (needs `python3-evdev` and real hardware)
- `generate_keys.py` — One-time Ed25519 keypair generator
- `kiosk.sh` — Pi startup script (updates the checkout, launches client.py, reads port from config, opens Chromium)
- `migrate.sh` — One-time migration script for Pis on the old standalone `checkin-client` repo
- `Dockerfile`, `healthcheck.py` — The container image and its local health check (see below)
- `config.json` — Runtime configuration (not committed)
- `client.key` — Ed25519 private key (not committed)

## Container image

`Dockerfile` builds the client alone, for arm64 and a 64-bit OS. To change the
platform, change the one `ARG PLATFORM` at the top. Chromium stays on the host, and
the image holds no key or config.

```bash
docker build -t kiosk-client client/
```

```bash
docker run --name kiosk-client --rm --network host \
  --read-only --tmpfs /tmp --cap-drop ALL \
  --device-cgroup-rule 'c 13:* rm' -v /dev/input:/dev/input:ro \
  --group-add <input gid> --user <kiosk uid> \
  -v /var/lib/kiosk:/data \
  -v /etc/kiosk/client.key:/data/client.key:ro \
  -v /etc/kiosk/config.json:/data/config.json:ro \
  -v /etc/localtime:/etc/localtime:ro \
  --log-driver journald \
  kiosk-client
```

The container runs from `/data`, so `outbox.db` and the marker files live in the
host's `/var/lib/kiosk`. `outbox.db` holds the scan queue and one saved copy of
the kiosk's view (who is inside, the last roster with names, known keyholders), so
a restart while offline keeps that view. Only the kiosk user can read the file. `private_key_path` and `outbox_path` in the config must be
relative or point under `/data`. The client asks for a Chromium restart by writing
`/var/lib/kiosk/.chromium-bounce`; a host loop acts on the file and deletes it.

**Health check.** A host script runs this and reads the exit code:

```bash
docker exec kiosk-client python /app/healthcheck.py
```

It exits 0 when the proxy answers, the database opens and the scanner is held, and
otherwise prints what failed to stderr. It never contacts the server. Retry for
about a minute after a start: the proxy binds only after the first roster fetch,
which takes up to 10 seconds with the server down, so failures until then are
normal. A missing `evdev` or scanner, or an empty `usb_device`, never passes.

## Update channel

The Pi runs the latest **release tag**, not `main`. The server deploys from
releases, so a Pi following `main` runs client code whose server counterpart is
not deployed yet — the paths it calls may not exist.

`kiosk.sh` fetches and checks out the target at the top of each loop;
`client.py`'s `version_poller` restarts the client when `HEAD` no longer matches
it. Both read the target from `resolve_update_target()`, so they cannot disagree
about where the Pi is meant to be.

A release is only adopted if its own `kiosk.sh` carries the
`release-channel: tags` marker. Until such a release is cut the Pi keeps
following `main`, unchanged. Without that gate the changeover would oscillate: a
release predating the channel pulls `main` back on its next loop, so the Pi would
bounce between the two once per poll.

To see what a Pi would move to:

```bash
cd ~/checkin/client && python3 -c 'import client; print(client.resolve_update_target())'
```
