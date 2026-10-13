# s-read-function — the scheduled Shopify orders/payouts/balance-transaction sync,
# packaged as an ECS task image (infra: innovationtreehouse/infra#112).
#
# Build context is the REPO ROOT (same convention as checkin-app/Dockerfile) so the
# workspace install can see the root package.json + lockfile and every workspace
# manifest. Build with:  docker build -f s-read-function/Dockerfile .
#
# The container runs the EXISTING CLI entry (src/cli.ts) via tsx — the same code path
# proven locally — not a bundled artifact. The default CMD selects the sync mode from
# the SYNC_MODE env var (contract with infra#112):
#   - the s-read-sync task-def / hourly schedule sets SYNC_MODE=incremental
#   - the one-time backfill is a run-task with a SYNC_MODE=backfill env override
#   - the s-read-migrate task-def overrides the command entirely:
#       ["npm", "run", "db:deploy", "-w", "@inventory/s-ingest-core"]
#     (works from this image's WORKDIR /app; the script is container-safe — prisma reads
#     SHOPIFY_READ_DATABASE_URL from process.env, and a package-local .env is optional)
# (CMD, not ENTRYPOINT, on purpose: ECS containerOverrides replace the command wholesale,
# and the migrate task-def's command — plus the shell that expands SYNC_MODE — would be
# mangled by an ENTRYPOINT prefix.)
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app

# Prisma's migrate engine links libssl, which node:22-slim doesn't ship — without it
# prisma falls back to a guessed openssl version with a "may not work" warning.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Manifests + lockfile first for a cache-friendly `npm ci` layer. ALL workspace
# manifests are copied (npm needs the full workspace graph to validate the lockfile)
# but only the three workspaces s-read needs are installed below.
COPY package.json package-lock.json tsconfig.base.json ./
COPY checkin-app/package.json checkin-app/
COPY s-read-function/package.json s-read-function/
COPY s-replay-function/package.json s-replay-function/
COPY monitoring-relay-function/package.json monitoring-relay-function/
COPY monitoring-watchdog-function/package.json monitoring-watchdog-function/
COPY packages/money/package.json packages/money/
COPY packages/monitoring-db/package.json packages/monitoring-db/
COPY packages/pg-test-harness/package.json packages/pg-test-harness/
COPY packages/s-ingest-core/package.json packages/s-ingest-core/
COPY packages/telemetry/package.json packages/telemetry/

# Scoped install: s-read-function + the two DB packages it imports (their devDeps
# carry the prisma CLI needed for generate + the migrate task's `db:deploy`).
# --ignore-scripts: the DB packages' postinstall runs `prisma generate`, which can't
# work in this manifests-only layer (no schema yet) — it runs explicitly below.
RUN npm ci -w s-read-function -w @inventory/s-ingest-core -w @inventory/monitoring-db --ignore-scripts

COPY packages/ packages/
COPY s-read-function/ s-read-function/
RUN npm run db:generate -w @inventory/s-ingest-core && npm run db:generate -w @inventory/monitoring-db

# RDS TLS (same as checkin-app/Dockerfile): the pg driver verifies the server cert and
# Amazon's RDS CA is not in the OS trust store — without this every query dies with
# "unable to get local issuer certificate".
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem

# WORKDIR stays /app (the workspace root) so the migrate task-def's baked
# `npm run ... -w ...` command resolves the workspace graph. No --env-file anywhere:
# config comes from real env vars (ECS task-def `secrets` + `environment`) and fails
# loud (exit 1) on missing/invalid config via the Zod loaders in s-ingest-core.
# `exec` so node is PID 1 and receives ECS stop signals directly.
CMD ["sh", "-c", "exec node --import tsx s-read-function/src/cli.ts \"${SYNC_MODE:-incremental}\""]
