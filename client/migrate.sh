#!/usr/bin/env bash
# Migrate a kiosk Pi from the old checkin-client repo to the unified checkin monorepo.
#
# Delivery: this script is committed to the checkin-client repo so each Pi
# fetches it on its next kiosk-loop `git pull`. SSH in and run:
#
#   ~/checkin-client/migrate.sh
#
# Idempotent: safe to re-run if it fails partway. Preserves config.json and
# client.key (both gitignored) by copying them into the new repo location.

set -euo pipefail

OLD_DIR="$HOME/checkin-client"
NEW_DIR="$HOME/checkin"
NEW_CLIENT_DIR="$NEW_DIR/client"
BACKUP_DIR="$HOME/checkin-client.old"
AUTOSTART="$HOME/.config/openbox/autostart"
MONOREPO_URL="${MONOREPO_URL:-git@github.com:innovationtreehouse/apps.checkin.git}"

log()  { echo "[migrate] $*"; }
fail() { echo "[migrate] ERROR: $*" >&2; exit 1; }

# --- Already done? ---
if [ ! -d "$OLD_DIR" ] && [ -f "$NEW_CLIENT_DIR/config.json" ]; then
  log "Already migrated ($NEW_CLIENT_DIR exists, $OLD_DIR gone). Nothing to do."
  exit 0
fi

# --- Preflight ---
[ -d "$OLD_DIR" ]              || fail "Expected $OLD_DIR to exist."
[ -f "$OLD_DIR/config.json" ]  || fail "Expected $OLD_DIR/config.json (your kiosk config)."
[ -f "$OLD_DIR/client.key"  ]  || fail "Expected $OLD_DIR/client.key (your kiosk private key)."

log "Verifying SSH access to the monorepo..."
if ! git ls-remote "$MONOREPO_URL" >/dev/null 2>&1; then
  fail "Cannot reach $MONOREPO_URL. Authorize this Pi's SSH key for the checkin repo first."
fi

# --- 1. Clone (or refresh) the monorepo (non-destructive: kiosk keeps running) ---
if [ ! -d "$NEW_DIR" ]; then
  log "Cloning monorepo into $NEW_DIR"
  git clone "$MONOREPO_URL" "$NEW_DIR"
else
  log "$NEW_DIR already exists; fetching latest main"
  git -C "$NEW_DIR" fetch origin
  git -C "$NEW_DIR" checkout main
  git -C "$NEW_DIR" pull --ff-only origin main
fi

# Bail BEFORE touching the kiosk if the monorepo isn't ready yet.
[ -d "$NEW_CLIENT_DIR" ] || fail "$NEW_CLIENT_DIR not found in monorepo. Was the subtree merge run? Aborting before touching the kiosk."

# --- 2. Stop the kiosk loop ---
log "Stopping any running kiosk processes..."
pkill -f kiosk.sh  || true
pkill -f client.py || true
sleep 1

# --- 3. Back up secrets out-of-tree (defense in depth) ---
SECRETS_BACKUP="$HOME/.kiosk-migrate-backup"
mkdir -p "$SECRETS_BACKUP"
chmod 700 "$SECRETS_BACKUP"
log "Copying secrets to $SECRETS_BACKUP (will remain after script exits)"
cp "$OLD_DIR/config.json" "$SECRETS_BACKUP/config.json"
cp "$OLD_DIR/client.key"  "$SECRETS_BACKUP/client.key"
chmod 600 "$SECRETS_BACKUP/client.key"

# --- 4. Restore secrets into the new location ---
log "Installing secrets into $NEW_CLIENT_DIR"
cp "$SECRETS_BACKUP/config.json" "$NEW_CLIENT_DIR/config.json"
cp "$SECRETS_BACKUP/client.key"  "$NEW_CLIENT_DIR/client.key"
chmod 600 "$NEW_CLIENT_DIR/client.key"

# --- 5. Update Openbox autostart ---
if [ -f "$AUTOSTART" ]; then
  if grep -q 'checkin-client' "$AUTOSTART"; then
    log "Updating kiosk.sh path in $AUTOSTART"
    cp "$AUTOSTART" "$AUTOSTART.pre-monorepo.bak"
    sed -i 's|checkin-client|checkin/client|g' "$AUTOSTART"
  else
    log "No 'checkin-client' reference found in $AUTOSTART; leaving alone."
  fi

  if ! grep -q 'checkin/client.*kiosk\.sh' "$AUTOSTART"; then
    log "WARNING: $AUTOSTART does not contain the expected kiosk.sh launch line."
    log "         Add this line by hand before rebooting:"
    log "             cd ~/checkin/client && ./kiosk.sh &"
  fi
else
  log "WARNING: $AUTOSTART not found. Add the kiosk.sh launcher manually before rebooting."
fi

# --- 6. Park the old dir for rollback ---
if [ -d "$OLD_DIR" ]; then
  if [ -e "$BACKUP_DIR" ]; then
    TS="$(date +%Y%m%d-%H%M%S)"
    log "$BACKUP_DIR already exists; parking old dir as $BACKUP_DIR.$TS instead."
    mv "$OLD_DIR" "$BACKUP_DIR.$TS"
  else
    log "Renaming $OLD_DIR -> $BACKUP_DIR"
    mv "$OLD_DIR" "$BACKUP_DIR"
  fi
fi

log ""
log "Migration complete."
log "  1. Verify autostart:  grep kiosk.sh $AUTOSTART"
log "  2. Reboot:            sudo reboot"
log "  3. Once the kiosk is healthy for ~24h, you can remove:"
log "        rm -rf $BACKUP_DIR $SECRETS_BACKUP"
