# Sourced by .github/workflows/security-boundary-isolation.yml and its self-check.
# is_marker_only_route_change BASE HEAD FILE: true when FILE existed at BASE and its
# BASE...HEAD diff only adds `// registry-first: <VERB>` lines. --diff-filter=M
# drops an added or deleted file; a binary change reports "-" counts and fails.
is_marker_only_route_change() {
  local stat added deleted markers
  stat=$(git diff --no-renames --diff-filter=M --numstat "$1"..."$2" -- "$3") || return 1
  read -r added deleted _ <<< "$stat"
  { [ "$deleted" = 0 ] && [ "$added" -gt 0 ]; } 2>/dev/null || return 1
  markers=$(git diff --no-renames -U0 "$1"..."$2" -- "$3" |
    grep -cE '^\+[[:space:]]*//[[:space:]]*registry-first:[[:space:]]*(GET|POST|PUT|PATCH|DELETE)[[:space:]]*$' || true)
  [ "$markers" = "$added" ]
}
