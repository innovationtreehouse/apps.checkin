#!/bin/sh
# Runs `npm -w <package> <args>` for every library in checkin-app/libraries.json
# (each with its own Prisma schema and <NAME>_DATABASE_URL database). Fails on an
# unparseable or empty list, and stops at the first failing library.
#   scripts/each-library.sh run db:generate
# --list prints "<name> <package> <dir>" per library instead (no install needed):
#   scripts/each-library.sh --list
set -eu
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--list" ]; then
  # ponytail: libraries live under packages/*; widen if one moves to another workspace glob.
  exec node -e '
    const fs = require("fs");
    const dirs = fs.readdirSync("packages").map(d => "packages/" + d).filter(d => fs.existsSync(d + "/package.json"));
    for (const l of require("./checkin-app/libraries.json")) {
      const dir = dirs.find(d => JSON.parse(fs.readFileSync(d + "/package.json", "utf8")).name === l.package);
      if (!dir) throw new Error("each-library: no packages/* workspace named " + l.package);
      console.log(l.name + " " + l.package + " " + dir);
    }'
fi
entries=$(node -p "require('./checkin-app/libraries.json').map(l => l.name + '=' + l.package).join(' ')")
if [ -z "$entries" ]; then
  echo "each-library: checkin-app/libraries.json lists no libraries" >&2
  exit 1
fi
for entry in $entries; do
  echo "[${entry%%=*}] npm -w ${entry#*=} $*"
  npm -w "${entry#*=}" "$@"
done
