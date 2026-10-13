# @inventory/pg-test-harness

The fleet template for **Postgres integration testing**. Every package with a real-Postgres
integration tier boots a throwaway, migration-fresh container via this harness instead of
assuming a hand-provisioned local/shared Postgres.

## Why

It removes two whole fragility classes and cuts disk churn:

- **No schema drift.** Each run applies the package's own committed migrations
  (`prisma migrate deploy`) into a fresh database. "What the tests run on" can never diverge
  from "what deploy applies."
- **No shared-DB contention.** Each `vitest run` gets its own database; nothing leaks
  between runs or developers.
- **Low disk churn.** The container's data dir is tmpfs (RAM) with durability off
  (`fsync`/`synchronous_commit`/`full_page_writes`), so truncate-between-tests is cheap and
  nothing lands on the host disk.

The runtime client stays env-driven — production reads its domain URL var
(`SHOPIFY_READ_DATABASE_URL`, `MONITORING_DATABASE_URL`, …). That env-read path is guarded
against drift by each package's `client.construction.test.ts`, so the integration tier can
build clients explicitly without leaving the wiring untested.

## Requirements

A running Docker daemon (Docker Desktop, OrbStack, or Colima). If Docker is absent the
harness provides no URL and the DB-gated suites **skip** (they don't fail) — so `npm test`
stays green on a machine without Docker.

## Onboarding a new Postgres function (~6 lines)

1. **`test/globalSetup.ts`** — boot + migrate:
   ```ts
   import { fileURLToPath } from "node:url";
   import { pgGlobalSetup } from "@inventory/pg-test-harness";

   export default pgGlobalSetup({
     migrateCwd: fileURLToPath(new URL("..", import.meta.url)), // dir with prisma.config.ts
     envVar: "MY_DATABASE_URL",     // the var your prisma.config.ts reads
     provideKey: "myDbUrl",         // any unique key
   });
   ```
   If your function consumes a schema owned by another package (as `s-replay-function` uses
   `s-ingest-core`), point `migrateCwd` at that package instead.

2. **`test/setupEnv.ts`** — publish the URL into the worker's env:
   ```ts
   import { applyHarnessEnv } from "@inventory/pg-test-harness";
   applyHarnessEnv({ envVar: "MY_DATABASE_URL", provideKey: "myDbUrl" });
   ```

3. **`vitest.config.ts`** — wire both:
   ```ts
   test: {
     globalSetup: ["./test/globalSetup.ts"],
     setupFiles: ["./test/setupEnv.ts"],
   }
   ```

4. Add `"@inventory/pg-test-harness": "*"` to `devDependencies`.

Your existing DB gate (`describeDb` / `runIfDb`, which reads the env var) and
`singleConnClient()` helpers keep working unchanged — `setupEnv` sets the env var before any
test module evaluates.

## How the URL reaches the test

`globalSetup` runs in the main process; vitest tests run in separate worker processes, and
`process.env` does not cross that boundary. The harness uses vitest `provide`/`inject`:
`globalSetup` provides the container URL, and the worker-side `setupEnv` injects it and sets
`process.env[envVar]` — but only if unset, so an explicitly-exported URL (a developer
pointing at their own Postgres) always wins.

## Knobs

- `pgGlobalSetup({ image })` — override the pinned Postgres image (default
  `public.ecr.aws/docker/library/postgres:17-alpine`, the ECR Public mirror of the
  official image; pin to your deployed RDS major).
