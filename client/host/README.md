# Kiosk host layer

What runs on the Raspberry Pi around the client container. It cannot update
itself, so each change here costs an SSH session. Plan: `docs/in-design/KIOSK_CONTAINER.md`.

| File | Job |
| --- | --- |
| `kiosk-client.service` | Runs the container at the recorded digest; always restarts |
| `kiosk-update.timer` | Hourly, 23:00 to 05:00: `kioskctl check-release` |
| `kiosk-urgent.timer` | Every five minutes: `kioskctl check-urgent`, GHCR only |
| `kiosk-reboot.timer` | Reboots at 03:30, between update checks |
| `kiosk-browser` | Openbox autostart loop; relaunches Chromium on exit or on the restart marker |
| `kioskctl` | `status`, `deploy sha256:<digest>`, `back`, and the two timer checks |
| `install.sh` | Sets all of this up in place and starts nothing |
| `host.conf.example` | Becomes `/etc/kiosk/host.conf`: image, tag names, health command |

## Install

```bash
sudo client/host/install.sh <kiosk-user>
```

Needs Docker with the buildx plugin, and `flock`. The closing lines it prints say
what to set and what to start.

## How an image moves

A check compares the tag's digest with what is recorded. If it differs, the kiosk
pulls the image, restarts the service and runs `KIOSK_HEALTH_CMD` inside the
container until it passes or `KIOSK_HEALTH_TIMEOUT` ends. On failure the kiosk goes
back to the old digest and records the new one as failed, and the nightly check
skips a failed digest.

- A registry or pull failure moves nothing and is retried at the next check.
- A forced digest is recorded after the pull and before the swap, so it is applied
  once. Only a new digest on `kiosk-urgent` forces again.
- `deploy` and `back` record the digest they leave as failed, so the nightly check
  does not return to it until the release tag moves on.

State lives in `/var/lib/kiosk-host`, which the container cannot reach.

## Forcing or withdrawing a release

A successful prod deploy publishes the image and moves `kiosk-release`, so kiosks
update overnight. To move them sooner, or to withdraw a bad release, run **Force
kiosk update** in GitHub Actions.

1. Enter a release tag (`v1.2.3`) or a digest from an earlier run's summary. To
   withdraw a release, enter the last good one.
2. Get the run approved in the `kiosk-force` environment.
3. Kiosks apply it within five minutes, or when they reconnect. Badges during the
   restart are missed and a live close prompt is lost; the scan queue is safe.

The run summary records who forced what and where both tags were before.

- A digest already on `kiosk-urgent` does not force again, and the run warns of
  this. Going back to the image forced last time therefore waits for the nightly
  check, unless `kioskctl deploy` is run over SSH.
- The next release moves `kiosk-release` forward as usual. Re-running a withdrawn
  release's deploy publishes it again.

## Limits

A power cut between the swap and the health check leaves the new digest in place
with no rollback. A new force, or `kioskctl back` over SSH, recovers it.

## Tests

`client/test_host_layer.py` runs `kioskctl` against a fake `docker` on PATH.
