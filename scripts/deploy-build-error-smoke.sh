#!/usr/bin/env bash
# Deploy-build smoke (#1967): boot the production image against a migrated
# Postgres and check that each wired library's HTTP errors keep their status
# (400/409, never 500) under `next build` bundling.
#
# Usage: deploy-build-error-smoke.sh <runner-image> <builder-image>
#   runner-image  the production image (checkin-app/Dockerfile, final stage)
#   builder-image the same Dockerfile's `builder` stage: full workspace +
#                 Prisma CLI, used for library migrations and cookie minting
set -euo pipefail

# One write route per wired library. A malformed JSON body must answer 400.
# A library's wiring PR adds its line here. A 403 means the probe person lacks
# the route's role (fix the role grant), not a pass; a route that admits more
# roles later must still answer 400.
MALFORMED_JSON_PROBES=(
  /api/catalog/categories
  /api/inventory/locations
  /api/expense/qb-accounts
)

# Duplicate create: the first POST must succeed, the second must answer 409.
DUPLICATE_PROBE_PATH=/api/catalog/categories
DUPLICATE_PROBE_BODY='{"name":"Smoke probe","letter":"Z"}'

RUNNER_IMAGE=${1:?runner image}
BUILDER_IMAGE=${2:?builder image}
NET=checkin-error-smoke
DB=checkin-error-smoke-db
APP=checkin-error-smoke-app
BASE=http://127.0.0.1:4000
PG=postgresql://prisma:prisma@$DB:5432

# Per-run secret, never committed: the app verifies the minted cookie with it.
SECRET=$(openssl rand -hex 32)
echo "::add-mask::$SECRET"

cleanup() {
  docker logs "$APP" 2>&1 | tail -80 || true
  docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_USER=prisma -e POSTGRES_PASSWORD=prisma -e POSTGRES_DB=checkmein \
  public.ecr.aws/docker/library/postgres:15 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$DB" pg_isready -U prisma -d checkmein >/dev/null 2>&1 && break
  sleep 1
done

psql() { docker exec -i "$DB" psql -v ON_ERROR_STOP=1 -U prisma -d checkmein -qtA "$@"; }
psql -c 'CREATE DATABASE catalog' -c 'CREATE DATABASE local_inventory' -c 'CREATE DATABASE expense'

docker run --rm --network "$NET" \
  -e DATABASE_URL="$PG/checkmein?sslmode=disable" \
  -e CATALOG_DATABASE_URL="$PG/catalog?sslmode=disable" \
  -e LOCAL_INVENTORY_DATABASE_URL="$PG/local_inventory?sslmode=disable" \
  -e EXPENSE_DATABASE_URL="$PG/expense?sslmode=disable" \
  "$BUILDER_IMAGE" sh -ec '
    npm -w checkin-app exec -- prisma migrate deploy
    npm -w @inventory/global-catalog exec -- prisma migrate deploy
    npm -w @inventory/local-inventory exec -- prisma migrate deploy
    npm -w @inventory/expense exec -- prisma migrate deploy'

PERSON_ID=$(psql <<'SQL'
WITH h AS (INSERT INTO "Household" (name) VALUES ('Smoke') RETURNING id),
     p AS (INSERT INTO "Person" (name, email, "householdId")
           SELECT 'Smoke Probe', 'smoke-probe@example.com', id FROM h RETURNING id),
     r AS (INSERT INTO "PersonRole" ("personId", role)
           SELECT p.id, k::"PersonRoleKind" FROM p, unnest(ARRAY['FINANCE', 'BOARD', 'INVENTORY_MANAGER']) k)
SELECT id FROM p;
SQL
)

# Persona-mint is off under NODE_ENV=production; a JWT carrying the person id
# is enough, since the jwt callback re-reads roles by token.id on every request.
TOKEN=$(docker run --rm -w /app/checkin-app -e SECRET="$SECRET" -e PERSON_ID="$PERSON_ID" \
  "$BUILDER_IMAGE" node -e '
    require("next-auth/jwt")
      .encode({ secret: process.env.SECRET, token: { id: Number(process.env.PERSON_ID), sub: process.env.PERSON_ID } })
      .then((t) => process.stdout.write(t));')
echo "::add-mask::$TOKEN"
COOKIE="next-auth.session-token=$TOKEN"

docker run -d --name "$APP" --network "$NET" -p 4000:4000 \
  -e DATABASE_URL="$PG/checkmein?sslmode=disable" \
  -e CATALOG_DATABASE_URL="$PG/catalog?sslmode=disable" \
  -e LOCAL_INVENTORY_DATABASE_URL="$PG/local_inventory?sslmode=disable" \
  -e EXPENSE_DATABASE_URL="$PG/expense?sslmode=disable" \
  -e NEXTAUTH_URL="$BASE" -e AUTH_TRUST_HOST=true -e NEXTAUTH_SECRET="$SECRET" \
  -e GOOGLE_CLIENT_ID=smoke-placeholder -e GOOGLE_CLIENT_SECRET=smoke-placeholder \
  -e CHECKIN_ENV=dev -e AWS_REGION=us-east-2 \
  "$RUNNER_IMAGE" >/dev/null

for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/csrf" || true)" = 200 ] && break
  sleep 2
done

post() { curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE$1" \
  -H "Cookie: $COOKIE" -H 'Content-Type: application/json' --data-raw "$2"; }

failed=0
expect() { # <label> <want> <got>
  if [ "$3" = "$2" ]; then echo "ok   $1 -> $3"
  else echo "::error::$1 -> $3 (want $2)"; failed=1; fi
}

for path in "${MALFORMED_JSON_PROBES[@]}"; do
  expect "POST $path (malformed JSON)" 400 "$(post "$path" '{"name":')"
done

first=$(post "$DUPLICATE_PROBE_PATH" "$DUPLICATE_PROBE_BODY")
case "$first" in 2??) echo "ok   POST $DUPLICATE_PROBE_PATH (create) -> $first" ;;
  *) echo "::error::POST $DUPLICATE_PROBE_PATH (create) -> $first (want 2xx)"; failed=1 ;; esac
expect "POST $DUPLICATE_PROBE_PATH (duplicate)" 409 "$(post "$DUPLICATE_PROBE_PATH" "$DUPLICATE_PROBE_BODY")"

exit "$failed"
