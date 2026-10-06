#!/usr/bin/env bash
# Print the tail of a stopped ECS task's CloudWatch stream, with row data redacted.
#
#   scripts/dump-task-logs.sh <log-group> <log-stream>               # redacted tail
#   scripts/dump-task-logs.sh --pointer-only <log-group> <log-stream> # no task output
#
# The repo is public, so Actions logs are world-readable: anything printed here
# is published. Postgres failures echo row data (`DETAIL: Key (email)=(…)`,
# `Failing row contains (…)`, `CONTEXT: COPY "Person", line N: "<row>"`), so
# those lines are dropped and the full stream is left to IAM holders via the
# printed `aws logs` command. --pointer-only is for tasks whose output is
# prod data end to end (the staging prod-copy).
#
# The whole stream is paged (a failing task's error is at the END) and the last
# DUMP_TAIL_LINES (default 50) redacted lines are printed. get-log-events returns
# at most 1MB/10k events per call and a nextForwardToken that STOPS ADVANCING at
# the end of the stream — that repeat is the documented end-of-stream signal.
#
# Best-effort by contract: every failure path prints a marker and returns 0, so
# a logging problem can never fail a deploy that otherwise succeeded.
set -uo pipefail

POINTER_ONLY=0
[ "${1:-}" = "--pointer-only" ] && { POINTER_ONLY=1; shift; }
GROUP="${1:?usage: dump-task-logs.sh [--pointer-only] <log-group> <log-stream>}"
STREAM="${2:?usage: dump-task-logs.sh [--pointer-only] <log-group> <log-stream>}"
MAX_PAGES="${MAX_LOG_PAGES:-50}"
TAIL_LINES="${DUMP_TAIL_LINES:-50}"

pointer() {
    echo "(log group: $GROUP  stream: $STREAM)"
    echo "(full stream, IAM only: aws logs get-log-events --log-group-name '$GROUP' --log-stream-name '$STREAM' --start-from-head --query 'events[].message' --output text)"
}

if [ "$POINTER_ONLY" = 1 ]; then
    echo "(task output not printed: this task handles prod data and this repo's Actions logs are public)"
    pointer
    exit 0
fi

# Drops lines that can carry row values and masks the quoted value in
# input-syntax errors. Prints the redacted-line count to fd 3.
redact() {
    awk '
        in_copy { if ($0 == "\\.") in_copy = 0; n++; next }
        /^COPY .* FROM stdin;?$/ { in_copy = 1; print; next }
        index($0, "\t") ||
        /(^|[: ])(DETAIL|CONTEXT):/ ||
        /Failing row/ ||
        /Key \(/ { n++; next }
        {
            if (match($0, /input (syntax|value) for [^:]*: "/)) $0 = substr($0, 1, RSTART + RLENGTH - 1) "[redacted]\""
            print
        }
        END { print n + 0 > "/dev/fd/3" }
    '
}

RAW="$(mktemp)"; trap 'rm -f "$RAW" "$RAW.n"' EXIT
status=""
token=""; prev=""; page=0
while [ "$page" -lt "$MAX_PAGES" ]; do
    page=$((page + 1))
    if [ -z "$token" ]; then
        out=$(aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "$STREAM" \
                --start-from-head --limit 10000 --output json 2>&1)
    else
        out=$(aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "$STREAM" \
                --start-from-head --limit 10000 --next-token "$token" --output json 2>&1)
    fi
    if [ $? -ne 0 ]; then
        # Page 1 failing means no logs at all; a later page means we already
        # read most of it — say which, rather than implying nothing was read.
        [ "$page" = 1 ] && status="(could not fetch logs)" || status="(log fetch failed at page $page — output above is partial)"
        break
    fi
    printf '%s' "$out" | jq -r '.events[].message' >>"$RAW" 2>/dev/null || echo "(could not parse log page $page)" >>"$RAW"
    token=$(printf '%s' "$out" | jq -r '.nextForwardToken // empty' 2>/dev/null)
    [ -z "$token" ] && break
    [ "$token" = "$prev" ] && break
    prev="$token"
done

redact <"$RAW" 3>"$RAW.n" | tail -n "$TAIL_LINES"
redacted=$(cat "$RAW.n" 2>/dev/null || echo "?")
[ -n "$status" ] && echo "$status"
[ "$page" -ge "$MAX_PAGES" ] && echo "(log dump truncated at $MAX_PAGES pages — raise MAX_LOG_PAGES if this is real output and not a loop)"
echo "(showing last $TAIL_LINES lines; $redacted line(s) redacted as possible row data — DETAIL/CONTEXT/Failing row/Key (…)/COPY data)"
pointer
exit 0
