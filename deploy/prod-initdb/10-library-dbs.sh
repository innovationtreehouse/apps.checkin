#!/bin/sh
# Creates each checkin-hosted library's database, named by its libraries.json
# "name" (mounted at /libraries.json), with the two-role model of the AWS
# cluster bootstrap (infra.aws modules/checkin-bootstrap/bootstrap.sh):
#   <name>_owner — owns the database; only the migrate step connects as it.
#   <name>_dml   — the app's runtime role; rows only, no DDL.
# Passwords come from <NAME>_OWNER_DB_PASSWORD / <NAME>_DML_DB_PASSWORD (NAME is
# the upper-cased name). Postgres runs this only on a fresh data volume; it is
# idempotent, so it can also be re-run by hand against a running server.
# Migrations run separately (`prisma migrate deploy` as the owner role).
# ponytail: sed parse assumes one "name" per line; swap for jq if the file grows nesting.
set -eu
for db in $(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' /libraries.json); do
  NAME=$(echo "$db" | tr '[:lower:]' '[:upper:]')
  eval "owner_pw=\${${NAME}_OWNER_DB_PASSWORD:-}"
  eval "dml_pw=\${${NAME}_DML_DB_PASSWORD:-}"
  if [ -z "$owner_pw" ] || [ -z "$dml_pw" ]; then
    echo "10-library-dbs: ${NAME}_OWNER_DB_PASSWORD and ${NAME}_DML_DB_PASSWORD must both be set" >&2
    exit 1
  fi

  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v db="$db" -v owner="${db}_owner" -v dml="${db}_dml" \
    -v owner_pw="$owner_pw" -v dml_pw="$dml_pw" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'owner')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'owner')\gexec
ALTER ROLE :"owner" WITH PASSWORD :'owner_pw';
SELECT format('CREATE ROLE %I LOGIN', :'dml')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'dml')\gexec
ALTER ROLE :"dml" WITH PASSWORD :'dml_pw';
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'owner')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db')\gexec
SQL

  # Grants run AS the owner: DEFAULT PRIVILEGES bind to the role that creates
  # every future migration's tables, and only the owner's PUBLIC revoke takes effect.
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" \
    -v db="$db" -v owner="${db}_owner" -v dml="${db}_dml" <<'SQL'
SET ROLE :"owner";
REVOKE CONNECT ON DATABASE :"db" FROM PUBLIC;
GRANT  CONNECT ON DATABASE :"db" TO :"dml";
GRANT USAGE ON SCHEMA public TO :"dml";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"dml";
-- UPDATE is required for setval(); USAGE/SELECT covers nextval/currval only.
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"dml";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"dml";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"dml";
RESET ROLE;
SQL
done
