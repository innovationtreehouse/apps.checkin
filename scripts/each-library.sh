#!/bin/sh
# Runs `npm -w <package> <args>` for every library in checkin-app/libraries.json
# (each with its own Prisma schema and <NAME>_DATABASE_URL database). Stops at
# the first failure.
#   scripts/each-library.sh run db:generate
set -eu
cd "$(dirname "$0")/.."
for entry in $(node -p "require('./checkin-app/libraries.json').map(l => l.name + '=' + l.package).join(' ')"); do
  echo "[${entry%%=*}] npm -w ${entry#*=} $*"
  npm -w "${entry#*=}" "$@"
done
