#!/usr/bin/env bash
# Runnable check for dump-task-logs.sh — stubbed `aws`, no network.
#
#   scripts/test-dump-task-logs.sh
#
# Pins that the tail of the stream (where the error is) is printed in order,
# that paging terminates, and that lines which can carry row data never reach
# the (public) Actions log.
set -uo pipefail
cd "$(dirname "$0")"
SCRIPT="$PWD/dump-task-logs.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"; export PATH="$T/bin:$PATH"
fail() { echo "FAIL: $*" >&2; exit 1; }
command -v timeout >/dev/null || timeout() { shift; "$@"; }  # macOS has no coreutils timeout

# Stub: 3 pages of 2 events, then a repeated token (end-of-stream signal).
cat > "$T/bin/aws" <<'EOF'
#!/usr/bin/env bash
tok=""
for ((i=0;i<$#;i++)); do :; done
args=("$@")
for ((i=0;i<${#args[@]};i++)); do [ "${args[$i]}" = "--next-token" ] && tok="${args[$((i+1))]}"; done
case "$FAKE_MODE:$tok" in
  fail:*)      echo "AccessDenied" >&2; exit 254 ;;
  failp2:t1)   echo "Throttled" >&2; exit 254 ;;
esac
case "$tok" in
  "")   echo '{"events":[{"message":"line1"},{"message":"line2"}],"nextForwardToken":"t1"}' ;;
  t1)   echo '{"events":[{"message":"line3"},{"message":"line4"}],"nextForwardToken":"t2"}' ;;
  t2)   echo '{"events":[{"message":"ERROR: the real failure"}],"nextForwardToken":"t2"}' ;;
esac
EOF
chmod +x "$T/bin/aws"

echo "1. pages the whole stream and prints it in order, including the final page"
out=$(FAKE_MODE=ok "$SCRIPT" grp strm | grep -v '^(')
n=$(grep -c . <<<"$out")
[ "$n" = "5" ] || { echo "$out"; fail "expected 5 lines, got $n"; }
[ "$(head -1 <<<"$out")" = "line1" ] || fail "first line wrong"
grep -q "ERROR: the real failure" <<<"$out" || fail "the LAST page was not printed — this is the original bug"
echo "   ✓ 5 lines, oldest first, final-page error present"

echo "2. terminates on the repeated forward token (no infinite paging)"
timeout 10 env FAKE_MODE=ok "$SCRIPT" grp strm >/dev/null || fail "did not terminate"
echo "   ✓ returned promptly"

echo "3. a total fetch failure is best-effort, not fatal"
out=$(FAKE_MODE=fail "$SCRIPT" grp strm); rc=$?
[ $rc -eq 0 ] || fail "must exit 0 so logging never fails a deploy (got $rc)"
grep -q "could not fetch logs" <<<"$out" || { echo "$out"; fail "no marker"; }
echo "   ✓ exit 0 with a marker"

echo "4. a mid-stream failure says the output is partial"
out=$(FAKE_MODE=failp2 "$SCRIPT" grp strm); rc=$?
[ $rc -eq 0 ] || fail "must exit 0 (got $rc)"
grep -q "line1" <<<"$out" || fail "should keep what it already read"
grep -q "partial" <<<"$out" || { echo "$out"; fail "should flag partial output"; }
echo "   ✓ keeps partial output and says so"

echo "5. the page cap is enforced and announced"
cat > "$T/bin/aws" <<'EOF'
#!/usr/bin/env bash
n=$RANDOM
echo "{\"events\":[{\"message\":\"x\"}],\"nextForwardToken\":\"t$n\"}"
EOF
chmod +x "$T/bin/aws"
out=$(MAX_LOG_PAGES=3 "$SCRIPT" grp strm)
grep -q "truncated at 3 pages" <<<"$out" || { echo "$out"; fail "cap not announced"; }
echo "   ✓ never-repeating token stops at the cap"

echo "6. row data is redacted, the rest kept, and the pointer printed"
cat > "$T/bin/aws" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *" --next-token "* ]] && { echo '{"events":[],"nextForwardToken":"t"}'; exit 0; }
jq -n '{nextForwardToken:"t", events:[
  "Applying migration 20260101_x",
  "psql:<stdin>:812: ERROR:  duplicate key value violates unique constraint \"Person_email_key\"",
  "DETAIL:  Key (email)=(alice@example.com) already exists.",
  "psql:<stdin>:900: DETAIL:  Failing row contains (7, Alice, 2011-04-05).",
  "ERROR:  new row for relation \"Person\" violates check constraint",
  "CONTEXT:  COPY \"Person\", line 3: \"7\tAlice\talice@example.com\"",
  "COPY public.\"Person\" (id, name, email) FROM stdin;",
  "8\tBob\tbob@example.com",
  "bob-without-tabs@example.com",
  "\\.",
  "ERROR:  invalid input syntax for type date: \"2011-99-05 secret\"",
  "ERROR: the real failure"
] | map({message:.})}'
EOF
chmod +x "$T/bin/aws"
out=$("$SCRIPT" grp strm)
for leak in alice Alice Bob bob 2011-04-05 secret; do
  grep -q "$leak" <<<"$out" && { echo "$out"; fail "leaked '$leak'"; }
done
for keep in "Applying migration" "Person_email_key" "violates check constraint" 'COPY public."Person"' 'invalid input syntax for type date: "\[redacted\]"' "ERROR: the real failure"; do
  grep -q "$keep" <<<"$out" || { echo "$out"; fail "dropped diagnostic line '$keep'"; }
done
grep -q "6 line(s) redacted" <<<"$out" || { echo "$out"; fail "redaction count wrong"; }
grep -q "aws logs get-log-events --log-group-name 'grp' --log-stream-name 'strm'" <<<"$out" || fail "no IAM pointer"
echo "   ✓ DETAIL/CONTEXT/Failing row/Key/COPY data gone, errors kept, pointer printed"

echo "7. only the last DUMP_TAIL_LINES lines are printed"
out=$(DUMP_TAIL_LINES=2 "$SCRIPT" grp strm | grep -v '^(')
[ "$(grep -c . <<<"$out")" = "2" ] || { echo "$out"; fail "tail not applied"; }
[ "$(tail -1 <<<"$out")" = "ERROR: the real failure" ] || fail "tail lost the last line"
echo "   ✓ tail keeps the end"

# Serves the given messages (one per argv) as a single-page stream.
stub_events() {
  printf '%s\n' "$@" | jq -R . | jq -s . > "$T/events.json"
  cat > "$T/bin/aws" <<EOF
#!/usr/bin/env bash
[[ " \$* " == *" --next-token "* ]] && { echo '{"events":[],"nextForwardToken":"t"}'; exit 0; }
jq '{nextForwardToken:"t", events: map({message:.})}' "$T/events.json"
EOF
  chmod +x "$T/bin/aws"
}

echo "8. a multi-line Failing row drops every continuation line"
stub_events \
  "psql:<stdin>:40: ERROR:  new row for relation \"Person\" violates check constraint \"dob_check\"" \
  "DETAIL:  Failing row contains (9, Carol, carol@example.com, 'note line1" \
  "note line2 carol-secret-2" \
  "" \
  "   indented line3 carol-secret-3)." \
  "ERROR: the real failure"
out=$("$SCRIPT" grp strm)
for leak in Carol carol line2 line3; do
  grep -q "$leak" <<<"$out" && { echo "$out"; fail "leaked '$leak'"; }
done
grep -q "violates check constraint" <<<"$out" || { echo "$out"; fail "dropped the leading ERROR"; }
grep -q "^ERROR: the real failure" <<<"$out" || { echo "$out"; fail "dropped the next ERROR"; }
grep -q "4 line(s) redacted" <<<"$out" || { echo "$out"; fail "continuation lines not counted"; }
echo "   ✓ continuation lines gone and counted, next ERROR kept"

echo "9. a multi-line CONTEXT COPY value drops every continuation line"
stub_events \
  "ERROR:  value too long for type character varying(10)" \
  "CONTEXT:  COPY \"Person\", line 3: \"10,Dave,dave@example.com,\"\"note line1" \
  "note line2 dave-secret-2\"\"\"" \
  "psql:<stdin>:52: ERROR: the real failure"
out=$("$SCRIPT" grp strm)
for leak in Dave dave line2; do
  grep -q "$leak" <<<"$out" && { echo "$out"; fail "leaked '$leak'"; }
done
grep -q "value too long" <<<"$out" || { echo "$out"; fail "dropped the leading ERROR"; }
grep -q "psql:<stdin>:52: ERROR: the real failure" <<<"$out" || { echo "$out"; fail "dropped the next ERROR"; }
grep -q "2 line(s) redacted" <<<"$out" || { echo "$out"; fail "continuation lines not counted"; }
echo "   ✓ continuation lines gone and counted, next ERROR kept"

echo "10. an unclosed COPY block ends at the next error line"
stub_events \
  "COPY public.\"Person\" (id, name, email) FROM stdin;" \
  "11	Erin	erin@example.com" \
  "erin-without-tabs@example.com" \
  "psql:<stdin>:61: ERROR:  extra data after last expected column" \
  "after the error"
out=$("$SCRIPT" grp strm)
grep -q "erin" <<<"$out" && { echo "$out"; fail "leaked COPY data"; }
grep -q "psql:<stdin>:61: ERROR:  extra data" <<<"$out" || { echo "$out"; fail "error swallowed by the COPY block"; }
grep -q "after the error" <<<"$out" || { echo "$out"; fail "lines after the error swallowed"; }
echo "   ✓ data dropped, error and later lines kept"

echo "11. --pointer-only never calls aws or prints task output"
printf '#!/usr/bin/env bash\necho CALLED >&2; exit 1\n' > "$T/bin/aws"
out=$("$SCRIPT" --pointer-only grp strm 2>&1); rc=$?
[ $rc -eq 0 ] || fail "exit $rc"
grep -q CALLED <<<"$out" && fail "aws was called"
grep -q "stream: strm" <<<"$out" || { echo "$out"; fail "no stream name"; }
echo "   ✓ stream name only"

echo "ALL CHECKS PASSED"
