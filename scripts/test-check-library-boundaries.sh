#!/usr/bin/env bash
# Runnable check for check-library-boundaries.mjs's DB-client rule: builds a
# throwaway repo root with fake packages and asserts pass/fail per case.
#
#   scripts/test-check-library-boundaries.sh
set -uo pipefail
CHECK="$(cd "$(dirname "$0")" && pwd)/check-library-boundaries.mjs"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# pkg <dir> <package.json body>
pkg() { mkdir -p "$T/packages/$1/src"; echo "$2" > "$T/packages/$1/package.json"; }

reset() {
  rm -rf "$T/packages" "$T/checkin-app"
  mkdir -p "$T/checkin-app/prisma"
  echo 'model Person { id Int @id }' > "$T/checkin-app/prisma/schema.prisma"
  pkg plain '{"name":"@x/plain"}'
  pkg db-dep '{"name":"@x/db-dep","dependencies":{"@prisma/client":"*"}}'
  pkg db-schema '{"name":"@x/db-schema"}'
  mkdir -p "$T/packages/db-schema/prisma"; touch "$T/packages/db-schema/prisma/schema.prisma"
}

# expect <0|1> <label>
expect() {
  out=$(node "$CHECK" "$T" 2>&1); code=$?
  [ "$code" -eq "$1" ] || fail "$2: exit $code, want $1
$out"
  echo "ok: $2"
}

reset
pkg lib '{"name":"@x/lib","library":true,"dependencies":{"@x/plain":"*"}}'
echo "import { a } from '@x/plain';" > "$T/packages/lib/src/index.ts"
expect 0 "library on a plain shared package passes"

reset
pkg lib '{"name":"@x/lib","library":true,"dependencies":{"@x/db-dep":"*"}}'
expect 1 "library depending on a shared package with @prisma/client fails"
grep -q "@x/db-dep holds a database client; reach that data through a port that checkin binds" <<<"$out" \
  || fail "message names the package and the port: $out"

reset
pkg lib '{"name":"@x/lib","library":true,"devDependencies":{"@x/db-schema":"*"}}'
expect 1 "library devDepending on a shared package with a prisma schema fails"

reset
pkg lib '{"name":"@x/lib","library":true}'
echo "import { getPrisma } from '@x/db-dep/client';" > "$T/packages/lib/src/index.ts"
expect 1 "library importing a DB-client shared package (undeclared) fails"
