#!/bin/sh
# Gives checkin's own database ($POSTGRES_DB) the runtime half of the library
# two-role model:
#   checkin_dml   — the app's runtime role; rows only, no DDL.
#   $POSTGRES_USER — the bootstrap superuser; owns checkin's tables and runs its
#                   migrations (there is no separate checkin owner role).
# Also closes CONNECT on the maintenance databases, so only the superuser can
# open them. Library databases are handled by 10-library-dbs.sh.
# Postgres runs this only on a fresh data volume. It is idempotent: on an
# existing volume run it once by hand before pointing DATABASE_URL at
# checkin_dml (see checkin-app/docs/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md).
set -eu
if [ -z "${CHECKIN_DML_DB_PASSWORD:-}" ]; then
  echo "05-checkin-roles: CHECKIN_DML_DB_PASSWORD must be set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" -v owner="$POSTGRES_USER" -v dml=checkin_dml \
  -v dml_pw="$CHECKIN_DML_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'dml')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'dml')\gexec
ALTER ROLE :"dml" WITH PASSWORD :'dml_pw';
REVOKE CONNECT ON DATABASE :"db" FROM PUBLIC;
GRANT  CONNECT ON DATABASE :"db" TO :"dml";
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"dml";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"dml";
-- UPDATE is required for setval(); USAGE/SELECT covers nextval/currval only.
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"dml";
-- FOR ROLE the migrating user: future migrations' tables are created by it.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"dml";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"dml";
SQL
