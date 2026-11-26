#!/usr/bin/env bash
# Runnable check for test-affected.mjs's refusals: builds a throwaway repo with a
# fake checkin-app and library, then asserts the exit code and message per case.
#
#   scripts/test-test-affected.sh
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/test-affected.mjs"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
# A planned step that runs hits this stub, never a real tool.
mkdir -p "$T/bin"; printf '#!/bin/sh\necho "npx ran: $*"; exit 1\n' > "$T/bin/npx"; chmod +x "$T/bin/npx"

# setup <libraries.json body>
setup() {
  rm -rf "$T/repo"; mkdir -p "$T/repo/scripts" "$T/repo/checkin-app/src/lib/catalog" "$T/repo/packages/catalog"
  cd "$T/repo" || fail "cd $T/repo"
  cp "$SCRIPT" scripts/test-affected.mjs
  echo '{"name":"root","workspaces":["checkin-app","packages/*"]}' > package.json
  # The fake jest scripts answer --listTests with one absolute test path.
  echo "console.log(process.cwd() + '/src/lib/catalog/a.test.ts')" > checkin-app/list-tests.js
  echo '{"name":"checkin-app","scripts":{"test":"node list-tests.js","test:integration":"node list-tests.js"},"dependencies":{"@x/catalog":"*"}}' \
    > checkin-app/package.json
  echo '{"name":"@x/catalog","library":true}' > packages/catalog/package.json
  echo "$1" > checkin-app/libraries.json
  git init -q -b main . && git add -A && git -c user.name=t -c user.email=t@t commit -qm base
  echo 'export const a = 1;' > checkin-app/src/lib/catalog/a.ts
}

# expect <code> <label> <args...>: runs with DATABASE_URL unset
expect() {
  local want=$1 label=$2; shift 2
  out=$(env -u DATABASE_URL PATH="$T/bin:$PATH" node scripts/test-affected.mjs --base main "$@" 2>&1); code=$?
  [ "$code" -eq "$want" ] || fail "$label: exit $code, want $want
$out"
  echo "ok: $label"
}

CATALOG='[{"name":"catalog","package":"@x/catalog"}]'

setup '[{"name":"catalog","package":"@x/catalog"},{"name":"newlib","package":"@x/catalog"}]'
expect 2 "a libraries.json entry with no WIRING entry is refused"
grep -qF 'libraries.json entry "newlib" (@x/catalog) has no WIRING entry in scripts/test-affected.mjs.' <<<"$out" \
  || fail "message names the entry and the table: $out"

setup '[{"name":"catalog","package":"@x/missing"}]'
expect 2 "a libraries.json entry with no workspace is refused"
grep -qF 'libraries.json entry "catalog" (@x/missing) has no workspace.' <<<"$out" || fail "message names the package: $out"

setup "$CATALOG"
expect 0 "--dry-run --db without DATABASE_URL prints the plan" --dry-run --db
grep -qF 'jest integration (1 files)' <<<"$out" || fail "plan lists the integration tier: $out"

setup "$CATALOG"
expect 2 "--db without DATABASE_URL is refused before anything runs" --db
grep -qF -- '--db needs DATABASE_URL' <<<"$out" || fail "message names DATABASE_URL: $out"
grep -qF '▶' <<<"$out" && fail "a step ran before the refusal: $out"

echo "test-affected checks passed"
