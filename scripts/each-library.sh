#!/bin/sh
# Runs `npm -w <package> <args>` for every library in checkin-app/libraries.json
# (each with its own Prisma schema and <NAME>_DATABASE_URL database). Fails on an
# unparseable or empty list, and stops at the first failing library.
#   scripts/each-library.sh run db:generate
set -eu
cd "$(dirname "$0")/.."
entries=$(node -p "require('./checkin-app/libraries.json').map(l => l.name + '=' + l.package).join(' ')")
if [ -z "$entries" ]; then
  echo "each-library: checkin-app/libraries.json lists no libraries" >&2
  exit 1
fi
for entry in $entries; do
  echo "[${entry%%=*}] npm -w ${entry#*=} $*"
  npm -w "${entry#*=}" "$@"
done
