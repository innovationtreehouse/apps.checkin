#!/bin/sh
# Creates each checkin-hosted library's database, named by its libraries.json
# "name" (mounted at /libraries.json). Postgres runs this only on a fresh data
# volume; an initialized server needs `CREATE DATABASE <name> OWNER prisma;`
# out of band. Migrations run separately (`prisma migrate deploy`).
# ponytail: sed parse assumes one "name" per line; swap for jq if the file grows nesting.
set -e
for db in $(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' /libraries.json); do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE DATABASE \"$db\" OWNER \"$POSTGRES_USER\";"
done
