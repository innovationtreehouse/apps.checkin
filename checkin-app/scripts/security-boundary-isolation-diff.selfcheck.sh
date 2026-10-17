#!/usr/bin/env bash
# Self-check for the changed-files diff logic in
# .github/workflows/security-boundary-isolation.yml.
#
# Proves the two defects the workflow fix addresses:
#   1. FALSE POSITIVE — diffing the checked-out merge ref (base...HEAD) sweeps
#      in main's own advance, mis-flagging a boundary file main landed as this
#      PR's change. The fix diffs the PR head (BASE...HEAD_SHA) so main's
#      advance is excluded.
#   2. FALSE NEGATIVE — an unreachable base SHA must FAIL loud, not degrade to
#      an empty changed-set "No changes" pass.
#
# No framework. Builds a synthetic git repo in a temp dir and asserts. Run:
#   bash checkin-app/scripts/security-boundary-isolation-diff.selfcheck.sh
set -euo pipefail

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main

BOUNDARY=checkin-app/src/security/registry.ts
mkdir -p "$(dirname "$BOUNDARY")" docs

# M0: base branch point — includes the boundary file.
mkdir -p checkin-app/src/security
printf 'export const routes = []\n' > "$BOUNDARY"
git add -A && git commit -qm "M0 base"
M0=$(git rev-parse HEAD)

# PR branch: one commit changing ONLY a doc.
git checkout -q -b pr
printf '# doc\n' > docs/foo.md
git add -A && git commit -qm "PR: docs only"
PR=$(git rev-parse HEAD)

# main advances with a commit that MODIFIES the boundary file (main's advance).
git checkout -q main
printf 'export const routes = [1]\n' > "$BOUNDARY"
git add -A && git commit -qm "M1 main advance: touch registry.ts"
M1=$(git rev-parse HEAD)

# The merge ref actions/checkout resolves for a pull_request: PR merged with
# the current tip of main.
MERGE=$(git commit-tree -p "$PR" -p "$M1" -m "merge ref" "$(git merge-tree --write-tree "$PR" "$M1" 2>/dev/null || git rev-parse "pr^{tree}")" 2>/dev/null || true)
if [ -z "$MERGE" ]; then
  git checkout -q -b mergeref "$PR"
  git merge -q --no-edit "$M1" || true
  MERGE=$(git rev-parse HEAD)
  git checkout -q main
fi

# --- the FIXED diff logic (mirrors the workflow) ---
fixed_changed() { # $1=BASE_SHA $2=HEAD_SHA -> prints changed files or fails
  local BASE_SHA=$1 HEAD_SHA=$2 CHANGED_RAW
  if ! CHANGED_RAW=$(git diff --name-only "$BASE_SHA"..."$HEAD_SHA"); then
    return 1
  fi
  printf '%s' "$CHANGED_RAW"
}

pass=0 fail=0
ok()  { echo "  ok: $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "1) FIXED logic, base=current-main-tip(M1), head=pr-tip -> only the doc"
OUT=$(fixed_changed "$M1" "$PR")
[ "$OUT" = "docs/foo.md" ] && ok "CHANGED == docs/foo.md (registry.ts excluded -> PASS)" \
                           || bad "expected docs/foo.md, got: [$OUT]"

echo "2) FIXED logic, base=divergence(M0), head=pr-tip -> still only the doc"
OUT=$(fixed_changed "$M0" "$PR")
[ "$OUT" = "docs/foo.md" ] && ok "CHANGED == docs/foo.md" \
                           || bad "expected docs/foo.md, got: [$OUT]"

echo "3) OLD logic (base...MERGE ref) WOULD sweep in main's advance"
OLD=$(git diff --name-only "$M0"..."$MERGE")
if echo "$OLD" | grep -qx "$BOUNDARY"; then
  ok "old logic reports $BOUNDARY -> would false-flag the PR"
else
  bad "expected old logic to include $BOUNDARY, got: [$OLD]"
fi

echo "4) FALSE-NEGATIVE guard: unreachable base SHA must FAIL, not pass empty"
if fixed_changed "0000000000000000000000000000000000000000" "$PR" >/dev/null 2>&1; then
  bad "unreachable base SHA passed (silent no-changes) — false negative"
else
  ok "unreachable base SHA fails loud (non-zero) as required"
fi

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
