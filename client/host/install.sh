#!/usr/bin/env bash
# Installs the kiosk host layer in place. Starts nothing: the old kiosk loop may
# still hold the scanner. Safe to re-run; existing config and state are kept.
# Usage: sudo ./install.sh <kiosk-user>
set -eu

KIOSK_USER=${1:?usage: install.sh <kiosk-user>}
HERE=$(cd "$(dirname "$0")" && pwd)
STATE=/var/lib/kiosk-host
CONF=/etc/kiosk/host.conf
UNITS="kiosk-client.service kiosk-update.service kiosk-update.timer kiosk-urgent.service kiosk-urgent.timer kiosk-reboot.service kiosk-reboot.timer"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
docker buildx version >/dev/null || { echo "docker with the buildx plugin is required" >&2; exit 1; }
command -v flock >/dev/null || { echo "flock is required" >&2; exit 1; }
INPUT_GID=$(getent group input | cut -d: -f3)
[ -n "$INPUT_GID" ] || { echo "the input group is required" >&2; exit 1; }

install -d -m 755 /etc/kiosk "$STATE"
install -d -m 750 -o "$KIOSK_USER" -g "$KIOSK_USER" /var/lib/kiosk

if [ ! -f "$CONF" ]; then
  install -m 644 "$HERE/host.conf.example" "$CONF"
  {
    echo "KIOSK_UID=$(id -u "$KIOSK_USER")"
    echo "KIOSK_INPUT_GID=$INPUT_GID"
  } >>"$CONF"
fi
# shellcheck source=client/host/host.conf.example
. "$CONF"

install -m 755 "$HERE/kioskctl" "$HERE/kiosk-browser" /usr/local/bin/
for unit in $UNITS; do
  install -m 644 "$HERE/$unit" /etc/systemd/system/
done
systemctl daemon-reload

if [ ! -f "$STATE/current.env" ]; then
  digest=$(docker buildx imagetools inspect "$KIOSK_IMAGE:$KIOSK_RELEASE_TAG" --format '{{.Manifest.Digest}}')
  docker pull "$KIOSK_IMAGE@$digest"
  echo "KIOSK_DIGEST=$digest" >"$STATE/current.env"
fi

# An existing urgent tag is an old force, not a new one. No tag yet leaves this
# empty, so the first force still applies.
if [ ! -f "$STATE/urgent" ]; then
  docker buildx imagetools inspect "$KIOSK_IMAGE:$KIOSK_URGENT_TAG" --format '{{.Manifest.Digest}}' >"$STATE/urgent" 2>/dev/null || : >"$STATE/urgent"
fi

KIOSK_HOME=$(getent passwd "$KIOSK_USER" | cut -d: -f6)
AUTOSTART=$KIOSK_HOME/.config/openbox/autostart
install -d -o "$KIOSK_USER" -g "$KIOSK_USER" "$KIOSK_HOME/.config" "$KIOSK_HOME/.config/openbox"
touch "$AUTOSTART"
chown "$KIOSK_USER:$KIOSK_USER" "$AUTOSTART"
grep -qF kiosk-browser "$AUTOSTART" || echo "/usr/local/bin/kiosk-browser &" >>"$AUTOSTART"

echo "Installed. Before starting, put client.key and config.json in /etc/kiosk."
echo "Stop the old kiosk loop and comment out its line in $AUTOSTART; going back during the soak restores it."
echo "Then: systemctl enable --now kiosk-client.service kiosk-update.timer kiosk-urgent.timer kiosk-reboot.timer"
