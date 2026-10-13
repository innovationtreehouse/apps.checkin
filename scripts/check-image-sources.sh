#!/usr/bin/env bash
# Fail if CI could pull an image anonymously from Docker Hub. Every image a
# workflow, action, Dockerfile, CI compose file or the testcontainers harness
# names must come from a registry host (public.ecr.aws for official images,
# which CI authenticates to); a bare `postgres:15` or a docker.io ref is Docker
# Hub. deploy/docker-compose.prod.yml runs on the prod host, not CI, so it is
# out of scope.
set -euo pipefail
cd "$(dirname "$0")/.."

refs() {
  # <file>:<line>:<image> for every image reference in the scanned files.
  grep -HnE '^[[:space:]]*-?[[:space:]]*image:[[:space:]]*[^[:space:]$]' \
    .github/workflows/*.yml .github/actions/*/action.yml \
    deploy/docker-compose.yml deploy/docker-compose.flow.yml \
    | sed -E 's/^([^:]+:[0-9]+):[[:space:]]*-?[[:space:]]*image:[[:space:]]*["'\'']?([^"'\''[:space:]]+).*/\1:\2/'
  git ls-files '*Dockerfile' | while read -r f; do
    stages=$(sed -nE 's/^FROM[[:space:]].*[[:space:]][Aa][Ss][[:space:]]+([^[:space:]]+).*/\1/p' "$f")
    grep -nE '^FROM[[:space:]]' "$f" | sed -E 's/^([0-9]+):FROM[[:space:]]+(--[^[:space:]]+[[:space:]]+)*([^[:space:]]+).*/\1:\3/' \
      | while IFS=: read -r n img; do
          grep -qxF "$img" <<<"$stages" || echo "$f:$n:$img"
        done
  done
  grep -HnE 'DEFAULT_PG_IMAGE = "' packages/pg-test-harness/src/container.ts \
    | sed -E 's/^([^:]+:[0-9]+):.*"([^"]+)".*/\1:\2/'
}

bad=0
while IFS= read -r ref; do
  img=${ref#*:*:}
  loc=${ref%":$img"}
  host=${img%%/*}
  if [ "$host" = "$img" ] || { [[ "$host" != *.* ]] && [[ "$host" != *:* ]] && [ "$host" != localhost ]; } \
    || [[ "$host" =~ ^((index|registry-1)\.)?docker\.io$ ]]; then
    echo "::error file=${loc%:*},line=${loc##*:}::Docker Hub image '$img' — use public.ecr.aws/docker/library/<image>"
    bad=1
  fi
done < <(refs)
exit "$bad"
