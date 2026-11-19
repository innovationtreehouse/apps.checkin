#!/usr/bin/env bash
# Runnable check for smoke-live-app.sh — a stubbed curl, no network.
#
#   scripts/test-smoke-live-app.sh
set -uo pipefail
cd "$(dirname "$0")"
SMOKE="$PWD/smoke-live-app.sh"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# The stub answers each call with the next "<code> <body>" line of $T/replies;
# a "000" line makes it fail like a timeout, writing no body.
cat > "$T/curl" <<'EOF'
#!/usr/bin/env bash
n=$(cat "$STUB/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB/n"
line=$(sed -n "${n}p" "$STUB/replies"); [ -n "$line" ] || line=$(tail -n 1 "$STUB/replies")
code=${line%% *}; body=${line#* }
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
[ "$code" = 000 ] && { printf 000; exit 28; }  # real curl leaves the file untouched
printf '%s' "$body" > "$out"
printf '%s' "$code"
EOF
chmod +x "$T/curl"

run() {  # run <expected-exit> <expected-calls> <reply lines...>
  local want=$1 calls=$2; shift 2
  printf '%s\n' "$@" > "$T/replies"; rm -f "$T/n"
  PATH="$T:$PATH" STUB="$T" SMOKE_INTERVAL=0 bash "$SMOKE" https://app.test >/dev/null
  local got=$?
  [ "$got" = "$want" ] || fail "replies [$*]: exit $got, want $want"
  [ "$(cat "$T/n")" = "$calls" ] || fail "replies [$*]: $(cat "$T/n") probes, want $calls"
}

run 0 1  "200 ok"
run 0 1  "302 "
run 0 4  "503 checkin-prod is waking up" "503 starting" "503 waking up" "307 "
run 0 3  "200 checkin-prod is waking up" "200 Waking Up" "200 ok"
run 0 4  "502 " "504 " "503 " "200 ok"
run 1 2  "503 waking up" "500 boom"
run 1 1  "404 nope"
run 1 1  "000 "
run 1 2  "503 checkin-prod is waking up" "000 "
run 1 60 "503 checkin-prod is waking up"
echo "smoke-live-app.sh: all checks passed"
