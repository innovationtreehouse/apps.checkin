#!/usr/bin/env bash
# Runs the kiosk flow tier: builds the kiosk images locally, brings up the flow
# stack with a throwaway signing key, and runs checkin-app/kiosk-flow inside it.
set -euo pipefail
cd "$(dirname "$0")/.."

# The old image: the first commit with client/Dockerfile, from before the saved view's table.
OLD_IMAGE_COMMIT=c7415d82f

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-kiosk-flow-$(basename "$PWD" | tr A-Z a-z | tr -cd a-z0-9_-)}"
compose() { docker compose -f deploy/docker-compose.flow.yml -f deploy/docker-compose.flow-kiosk.yml "$@"; }

docker build -q -t $COMPOSE_PROJECT_NAME:new client/
git archive "$OLD_IMAGE_COMMIT:client" | docker build -q -t $COMPOSE_PROJECT_NAME:old -

keys="$(docker run --rm --entrypoint python $COMPOSE_PROJECT_NAME:new -c \
  'from nacl.signing import SigningKey as K; k = K.generate(); print(k.encode().hex(), k.verify_key.encode().hex())')"
export KIOSK_SIGNING_SEED="${keys% *}" KIOSK_PUBLIC_KEY="${keys#* }"

cleanup() {
  ec=$?
  if [ "$ec" -ne 0 ]; then
    compose logs --no-color --tail 300 app || true
  fi
  # It shares the app's network and volume, so it goes first.
  docker rm -f "$COMPOSE_PROJECT_NAME-kiosk" >/dev/null 2>&1 || true
  compose down -v
  exit "$ec"
}
trap cleanup EXIT

compose up -d --wait --wait-timeout 600
compose exec -T app sh -lc "cd checkin-app && npx jest --config jest.kiosk-flow.config.mjs --ci --runInBand --forceExit"
