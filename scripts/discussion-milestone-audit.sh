#!/usr/bin/env bash
# Read-only staleness audit for a release-planning discussion.
#
#   scripts/discussion-milestone-audit.sh <discussion-number>
#   scripts/discussion-milestone-audit.sh --self-test
#
# No model, no API key, no writes. The discussion body is untrusted public text,
# and the only thing it can do here is choose which public issue numbers get
# READ. A number that turns out not to be an issue is reported, never followed.
set -euo pipefail

# ── parsing: no network, exercised by --self-test ────────────────────────────
# A candidate is a task-list line. Bold `**#N**` refs win, because the real
# discussions bold candidates and leave prose refs ("design merged in PR #1515")
# plain. A task line with no bold ref falls back to plain `#N`, so an
# off-convention line is flagged rather than silently dropped.
parse_candidates() {
  awk '
    /^[ \t]*[-*][ \t]+\[[ xX]\][ \t]/ {
      state = ($0 ~ /^[ \t]*[-*][ \t]+\[[xX]\]/) ? "checked" : "unchecked"
      n = 0; s = $0
      while (match(s, /\*\*#[0-9]+\*\*/)) {
        print state "\t" substr(s, RSTART + 3, RLENGTH - 5); n++
        s = substr(s, RSTART + RLENGTH)
      }
      if (n == 0) {
        s = $0
        while (match(s, /#[0-9]+/)) {
          print state "\t" substr(s, RSTART + 1, RLENGTH - 1)
          s = substr(s, RSTART + RLENGTH)
        }
      }
    }'
}

# Same convention apply.sh uses in #1602: the milestone is the first vMAJOR.MINOR
# in the title, so no text in the body can name one.
milestone_from_title() { grep -oE 'v[0-9]+\.[0-9]+' <<<"$1" | head -1 || true; }

self_test() {
  # The fixture is read into a variable first: bash 3.2's `$( )` scanner cannot
  # skip heredoc bodies, and this one contains both `#` and `'`.
  local fixture got want
  IFS= read -r -d '' fixture <<'FIXTURE' || true
## Candidates

- [ ] **#1409** — roster "Pending Since" always reads *Unknown*
- [x] **#1487** — age on the card
- [ ] **#1435** + **#1520** — one box, two issues
- [x] **#1441** — dates required *(design merged in PR #1515)*
  - [X] #1134 — plain ref, indented, uppercase X
- [ ] no number on this line at all

Prose mentioning #9999 is not a candidate.
| #1508 already carries v1.2 | table row, not a box |
FIXTURE
  got=$(printf '%s' "$fixture" | parse_candidates)
  want=$'unchecked\t1409\nchecked\t1487\nunchecked\t1435\nunchecked\t1520\nchecked\t1441\nchecked\t1134'
  diff <(echo "$got") <(echo "$want") || { echo "FAIL: parse_candidates"; exit 1; }
  test "$(milestone_from_title 'v1.2 — leaders can trust their screen')" = v1.2 || { echo "FAIL: milestone"; exit 1; }
  test -z "$(milestone_from_title 'no version here')" || { echo "FAIL: milestone empty"; exit 1; }
  echo "OK: 3 checks"
}

[ "${1:-}" = "--self-test" ] && { self_test; exit 0; }

NUM="${1:?usage: discussion-milestone-audit.sh <discussion-number> | --self-test}"
REPO="${REPO:-${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}}"

D=$(gh api graphql -f owner="${REPO%%/*}" -f name="${REPO##*/}" -F number="$NUM" -f query='
query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
  discussion(number:$number){number title url body}}}' --jq '.data.repository.discussion')
[ -n "$D" ] && [ "$D" != null ] || { echo "no discussion #$NUM in $REPO" >&2; exit 1; }

TITLE=$(jq -r .title <<<"$D"); BODY=$(jq -r .body <<<"$D"); URL=$(jq -r .url <<<"$D")
MS=$(milestone_from_title "$TITLE")

# Dedupe by number, preferring "checked" (sorts before "unchecked").
CANDS=$(parse_candidates <<<"$BODY" | sort -t$'\t' -k2,2n -k1,1 | awk -F'\t' '!seen[$2]++')

ERR=$(mktemp "${TMPDIR:-/tmp}/dma.XXXXXX"); trap 'rm -f "$ERR"' EXIT

closed=(); elsewhere=(); notissue=(); nchk=0; nunchk=0
while IFS=$'\t' read -r st n; do
  [ -n "${n:-}" ] || continue
  if [ "$st" = checked ]; then nchk=$((nchk + 1)); else nunchk=$((nunchk + 1)); fi
  # Only a real 404 is a finding. A rate limit, a 5xx or a broken token is a
  # broken run, and must not be reported as something wrong with the discussion.
  if ! meta=$(gh api "repos/$REPO/issues/$n" --jq '[.state,(.pull_request!=null),(.milestone.title//"")]|@tsv' 2>"$ERR"); then
    grep -q 'HTTP 404' "$ERR" || { echo "gh api failed reading issue #$n:" >&2; cat "$ERR" >&2; exit 1; }
    notissue+=("- **#$n** ($st) — not an issue in this repo (a discussion, or deleted)")
    continue
  fi
  IFS=$'\t' read -r state ispr msname <<<"$meta"
  if [ "$ispr" = true ]; then
    notissue+=("- **#$n** ($st) — is a pull request, not an issue")
    continue
  fi
  [ "$state" = open ] || closed+=("- **#$n** ($st) — is **$state**")
  if [ -n "$MS" ] && [ -n "$msname" ] && [ "$msname" != "$MS" ]; then
    elsewhere+=("- **#$n** ($st) — already on milestone **$msname**")
  fi
done <<<"$CANDS"

MSJSON=$(gh api "repos/$REPO/milestones?state=all&per_page=100" --paginate \
  | jq -s --arg t "$MS" 'add // [] | map(select(.title == $t)) | .[0] // {}')
MSNUM=$(jq -r '.number // empty' <<<"$MSJSON"); MSSTATE=$(jq -r '.state // empty' <<<"$MSJSON")

unlisted=()
if [ -n "$MSNUM" ]; then
  # Assigned, not `< <(…)`: a failed listing must abort the run, not silently
  # report an empty milestone.
  ONMS=$(gh api "repos/$REPO/issues?milestone=$MSNUM&state=all&per_page=100" --paginate \
    --jq '.[] | select(.pull_request == null) | [.number, .state] | @tsv')
  while IFS=$'\t' read -r n state; do
    [ -n "${n:-}" ] || continue
    cut -f2 <<<"$CANDS" | grep -qx "$n" && continue
    if grep -qE "(^|[^0-9])#$n([^0-9]|$)" <<<"$BODY"; then
      unlisted+=("- **#$n** ($state) — mentioned in the body's prose, but not a candidate box")
    else
      unlisted+=("- **#$n** ($state) — **not mentioned anywhere** in the discussion")
    fi
  done <<<"$ONMS"
fi

section() { local h=$1; shift; printf '### %s\n\n' "$h"
  if [ "$#" -eq 0 ]; then echo "_none_"; else printf '%s\n' "$@"; fi; echo; }

printf '## Staleness audit — [#%s](%s)\n\n%s\n\n' "$NUM" "$URL" "$TITLE"
printf 'Target milestone from the title: **%s** — ' "${MS:-(none found)}"
if [ -z "$MS" ]; then echo "the title names no \`vMAJOR.MINOR\`, so the two milestone-scoped sections are skipped."
elif [ -z "$MSNUM" ]; then echo "does not exist yet."
else echo "exists (#$MSNUM, **$MSSTATE**)."; fi
printf '\nCandidates parsed: **%s** checked, **%s** unchecked.\n\n' "$nchk" "$nunchk"

section "Candidates that are closed" ${closed[@]+"${closed[@]}"}
if [ -n "$MS" ]; then section "Candidates already on a different milestone" ${elsewhere[@]+"${elsewhere[@]}"}; fi
section "Candidates that are not issues" ${notissue[@]+"${notissue[@]}"}
if [ -n "$MS" ]; then section "On **$MS** but not a candidate" ${unlisted[@]+"${unlisted[@]}"}; fi

echo "_Read-only: this run made no writes and called no model._"
