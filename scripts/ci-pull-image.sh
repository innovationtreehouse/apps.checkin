#!/usr/bin/env bash
# Pull each image, retrying: registry pulls fail transiently (rate limits,
# 5xx) even when authenticated.
# Usage: ci-pull-image.sh <image>...
set -euo pipefail

for image in "$@"; do
  for delay in 5 15 0; do
    docker pull -q "$image" && break
    [ "$delay" = 0 ] && exit 1
    echo "pull of $image failed; retrying in ${delay}s"
    sleep "$delay"
  done
done
