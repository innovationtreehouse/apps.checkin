# Deploy / Migration Order of Operations

## Why this exists

PR #917's review found a critical deploy-sequencing bug no test could catch: its `DROP TABLE "HouseholdLead"` migration shipped in the **same release** as the backfill it depended on, while `origin/main`'s JWT callback reads `householdLeads` on every authenticated request. Migrations finish *before* the rolling deploy starts, so for the entire multi-minute drain window old code runs against a schema it can't read — site-wide 500s, plus any lead change old code wrote between backfill and drop silently destroyed. See [comment on #917](https://github.com/innovationtreehouse/checkin/pull/917#issuecomment-4889400528).

Two more incidents that same week (#791/#792, below) shared the root cause: nobody had written down what order migrations, code, and deploys actually happen in, so every PR re-derived it and some got it wrong. This doc is that missing reference. Read it before writing a migration; `.claude/skills/migration-safety/SKILL.md` turns it into a checklist that fires automatically when one's being built.

## The deploy sequence

Both `deploy-dev.yml` and `deploy-prod.yml` run the identical shape (dev triggers on merge to `main`; prod on a published GitHub release — see each file's header comment):

1. Merge/release triggers CI, then the deploy workflow builds and pushes an image.
2. **A one-off ECS task runs `prisma migrate deploy` to completion** — ALL pending migrations, in filename order — before anything else touches the service ([`deploy-dev.yml`](../../.github/workflows/deploy-dev.yml), [`deploy-prod.yml`](../../.github/workflows/deploy-prod.yml)). The database is VPC-only, so this task (and any other one-off DB access) has to run inside ECS on the service's own network config — there's no reaching it from a laptop or a GitHub-hosted runner directly.
   - The shared Aurora Serverless v2 cluster auto-pauses at zero traffic; the first connection after idle races the resume and Prisma throws `P1001`. The migrate task's container command is a retry loop with backoff for exactly this. Any new one-off DB task needs the same pattern — `checkin-app/src/lib/auroraResumeRetry.ts` is the equivalent for in-request reads (retries only `P1001`, rethrows everything else).
   - The task's own container logs (`/ecs/checkin-migrate-<env>`) are dumped into the Actions run output — added after the 2026-07-02 incident, where a bare "exit code 1" hid the real Prisma error in CloudWatch for a day.
3. **Only after migrations fully succeed** does `aws ecs update-service` start the rolling deploy.
4. Old tasks keep serving live traffic for a multi-minute drain window while new tasks come up and the old ones deregister.

**The consequence that drives every rule below:** *old code serves live traffic against the fully-migrated schema during every deploy.* A migration is never validated only against the code shipping alongside it — it has to be safe for whatever is running in production the moment before the deploy starts.

## The rules

### 1. Expand first
Additive changes — nullable columns, new tables, backfills, new indexes — may ship in the same release as the code that starts using them. Nothing currently running depends on their absence.

### 2. Cut over every reader and writer — not just the TypeScript ones
Before anything is removed or tightened, grep for every consumer of the old shape, including the surfaces `tsc` can't see:
- Shell scripts with raw SQL (`checkin-app/scripts/*.sh` — PR #917's own cutover sweep missed `full_reset_and_dev_init.sh`'s raw `INSERT INTO "HouseholdLead"`, which would have aborted the dev-reset script mid-run post-drop).
- Audit-log `tableName` string literals (`"HouseholdLead"` at the review's finding #6 — these don't get renamed by a schema change, they're just strings).
- `docs/VOCABULARY.md` and any other doc asserting a model exists.
- Seed files (`prisma/seed.ts`).

### 3. Contract last — in a separate, later release
Destructive changes — `DROP TABLE`/`DROP COLUMN`, `SET NOT NULL` on a column old code can still write null to, a rename of anything old code touches — ship only after the cutover code from rule 2 has fully rolled out. **Never in the same release as the expand stage that feeds it.** This is PR #917's critical finding: backfill + `DROP TABLE` together means old code 500s site-wide for the whole drain window, and writes landing between the backfill and the drop are silently lost.

This isn't a mechanical "always split into two PRs" rule — it's "prove old code can't violate the new constraint." PR #918 (`Household.name` → `NOT NULL`) shipped the backfill and the `SET NOT NULL` in one migration, one release, because every live write path already always wrote a non-null name (verified in the PR description) — there was no old-code path left that could violate it. If you can't make that same case, split the release.

### 4. Hand-write renames — never trust Prisma's generated migration for one
Prisma has no `RENAME` primitive in its diff engine: a column rename generates as `DROP COLUMN` + `ADD COLUMN`; a model rename generates as `DROP TABLE` + `CREATE TABLE`. On an empty database (every CI run, every fresh local setup) this looks fine. On a populated table it's a hard failure (`23502: ... contains null values`) or, worse, silent data loss when the new column happens to be nullable.

This is exactly what happened 2026-07-02: three generated "rename" migrations passed CI and every local run (empty DBs), then wedged dev for over a day when one of them hit a populated table. Fixed in [PR #791](https://github.com/innovationtreehouse/checkin/pull/791) by hand-rewriting them as `ALTER TABLE ... RENAME COLUMN` / `ALTER TABLE ... RENAME TO`, plus `RENAME CONSTRAINT` / `ALTER INDEX ... RENAME` for the objects that ride along with a table. (The rewritten migrations themselves no longer exist as separate files — [PR #792](https://github.com/innovationtreehouse/checkin/pull/792) squashed the whole chain into `20260703130000_squashed_init` the next day — so #791's diff is the exemplar to read, not a file in the current tree.)

### 5. Wrap multi-statement migrations in `BEGIN;` / `COMMIT;`
Prisma does not wrap a migration file in a transaction on Postgres ([prisma/prisma#15295](https://github.com/prisma/prisma/issues/15295)) — a multi-statement migration can **partially apply**. The 2026-07-02 incident hit this directly: one table's `ALTER` committed, the sibling table's rolled back in the same migration file, requiring manual surgical repair before the automated fix (#791) could even be deployed. If a migration touches more than one statement that needs to succeed or fail together, wrap it in explicit `BEGIN;` / `COMMIT;` — a failure becomes a clean atomic retry instead of a wedge.

Every new migration wraps, single-statement ones included. CI enforces this for every `migration.sql` a PR **adds**, in checkin's chain and in every `packages/*/prisma/migrations` chain: `migration-safety.yml` → "New migrations wrap in a transaction" fails a file whose first SQL line is not `BEGIN;` or whose last is not `COMMIT;` (blank and comment lines ignored). Migrations already on the base branch are never checked; editing one to satisfy the lint would break rule 6's checksum. Three explicit escapes:

- **SQL Postgres refuses inside a transaction** — `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, and the like. Add a comment line `-- no-transaction: <reason>` and make every statement retry-safe (`IF NOT EXISTS` / `IF EXISTS`), since a failure can leave some statements applied. `20260818140000_raw_badge_log_client_event_id` is the model for retry-safe statements.
- **A coalesce baseline** (its directory holds `reconcile.sql`) is exempt: it only ever runs on an empty database, which recovers by being recreated.
- **Pre-rule migrations** listed in `.github/migration-lint-grandfather.txt` are skipped. They landed on main before this rule and reach `rel/*` through a sync PR, where they count as added. The list is fixed; nothing new goes on it.

### 6. A failed migration wedges every future deploy until a human intervenes
A failed migration leaves a row in `_prisma_migrations` with no success recorded. Every subsequent `migrate deploy` — meaning every subsequent deploy of any kind, unrelated PRs included — fails fast with `P3009` ("migrate found failed migrations in the target database") until someone runs:

```
npx prisma migrate resolve --rolled-back <migration_name>   # it did NOT apply — safe default
npx prisma migrate resolve --applied <migration_name>       # ONLY after manually verifying the schema actually matches
```

Run this via the same one-off ECS task pattern used for deploys (register a migrate task-def revision, `run-task` with a command override, since the DB is VPC-only and unreachable from outside it). This is exactly the unblock PR #791 needed after merging.

The same P3009 class shows up after a **squash**: PR #792 replaced 49 migration files with one baseline (`20260703130000_squashed_init`). Any database that had already applied the old chain has to have its ledger reconciled by hand before its next deploy —

```sql
DELETE FROM "_prisma_migrations";
```
```
npx prisma migrate resolve --applied 20260703130000_squashed_init
```

— on **every** already-migrated database (dev, any long-lived local/shared DB), not just prod; a fresh database just runs the new baseline normally. The migration's own header comment carries these instructions for exactly this reason (see the top of that file). A squash-style migration PR legitimately **fails** `migration-safety.yml` (below) for this reason — that's expected, not a signal something's wrong with the PR.

The ledger's checksum (what `migrate resolve`/`migrate deploy` compare against) is a sha256 of the migration's `migration.sql` — editing an already-applied file's contents (as #791 did, on migrations no environment had applied yet) is safe; editing one that's already recorded as applied anywhere is not.

### 7. Dropping a security-bound model: one decommission PR

Dropping a Prisma model that has a `SCOPE_BINDINGS` entry welds four changes
into one green unit: `validateBindings` requires the binding to leave in the
exact PR the model leaves `classifications.ts`, the freshness guard welds
`classifications.ts` to `schema.prisma`, and the drift check welds the schema
drop to its `DROP TABLE` migration. The boundary-isolation workflow permits
that packaging through its **whole-entity decommission exception**
(`scripts/check-boundary-decommission.js`, see the workflow header and #1446):

1. **First release(s):** cut every reader/writer per rules 2–3, boundary
   grants included, until nothing serves the model.
2. **Decommission PR (one PR, all green):** remove the `model` from
   `schema.prisma`, the `DROP TABLE` migration, the regenerated
   `classifications.ts`, and the *entire* `SCOPE_BINDINGS` /
   `ROW_SCOPE_KEY` / `OPT_OUT_PENDING_ROUTE` entries for that model, plus
   test-oracle updates. Alongside the boundary removal the certifier admits
   the migration and **the route files of the registry entries this PR
   removes** — no other deletion. "It is a deletion" is not evidence a file
   belongs to the drop: a file nothing imports can still be a security
   control, and removing one breaks neither tsc nor the build.

The exception fails closed: a partial edit inside a surviving binding (which
can *widen* a grant — deleting one element of an `all:` match weakens it), an
addition, a re-tier, or any engine-file change disqualifies the PR, and the
boundary change must ship alone as usual. Removing a `ROW_SCOPE_KEY` entry
**widens**: `makeScopesHeld` returns the empty set for a row missing its scope
key, but with the entry gone `scopeKey === undefined` and the same row gets
`everyones`. For that container the schema-exit check is the only guard —
unlike `SCOPE_BINDINGS`/`registry.ts`, which narrow on their own. Do not relax
it on the belief that removals narrow.

The comparison is byte-strict apart from the two edits a whole-entity drop
forces — comments, and a `returns:` element naming a model dropped in the same
PR (that array is typed off the generated classifications, so leaving the
element in stops the entry compiling). Both are normalised on both sides;
nothing else is.

The same shape covers route kills: an entire `defineRoute` removal qualifies
when the PR also deletes the route file/verb export. One fail-closed corner:
the certifier requires the removed entry's route file to export the verb **at
base**, so removing an ALREADY-INERT entry fails certification — split that
into its own PR. Fallback if certification is unwanted: park the model in
`OPT_OUT_PENDING_ROUTE` in a boundary-only PR, then drop schema+migration
separately.

`checkin-app/src/middleware.ts` is a boundary file too — it is the site-wide
org-login/access gate, nothing imports it, so deleting or renaming it leaves
tsc and the build green. Any PR touching it ships alone, decommission or not.

### 8. Misc rules with incident backing
- **Postgres does not auto-index foreign key columns.** `Person.householdId` in PR #917 had no `@@index` anywhere in its migration history — collapsing the `HouseholdLead` join table into a flag on `Person` silently turned an indexed lookup into a full `Person` seq-scan on hot paths (check-in notification fan-out, nav badges). Add `@@index` for any relation scalar you actually query, in the same migration that adds the column.
- **Same-timestamp migrations from two open PRs interleave lexicographically at deploy time.** Prisma applies migrations in filename order; if two schema PRs are both open, check what order their timestamps put them in once both land — a same-timestamp collision (verified harmless for #917/#918's specific case, checked via `git merge-tree`) isn't guaranteed harmless in general.
- **Schema field changes need `/// @sensitivity:<tier>` annotations** (see `docs/security/SECURITY-POLICY.md`) with regenerated `classifications.ts` committed — this is a CI-enforced, CODEOWNERS-gated check, and it's a schema-adjacent step easy to forget in the middle of a migration-focused PR.
- **Aurora Serverless v2 auto-pauses.** Any new one-off DB task (not just the two deploy workflows) needs the retry-loop pattern from rule/step 2 above, or its first connection will race the resume and fail with `P1001`.

### 9. Database roles: create and grant before any URL points at them
The app connects as a DML-only role (rows, no DDL); migrations connect as the role that owns the tables. In AWS the roles come from the infra repo's cluster bootstrap (`checkin_<env>_dml`). In the self-hosted compose stack (`deploy/docker-compose.prod.yml`) they come from `deploy/prod-initdb/`:
- `05-checkin-roles.sh` creates `checkin_dml` on checkin's database, grants it DML on every existing table and sequence, and sets `DEFAULT PRIVILEGES FOR ROLE` the bootstrap user, so tables a later migration creates are granted automatically. It revokes CONNECT from PUBLIC on checkin's database, `postgres` and `template1`.
- `10-library-dbs.sh` does the same per library, with a real `<name>_owner` role.
- **Checkin's migrate uses the bootstrap user** (`POSTGRES_USER`), which owns checkin's existing tables. There is no separate checkin owner role yet. Moving ownership to one is a possible later step: it needs `ALTER ... OWNER TO` on every table, sequence and type of the live database (`REASSIGN OWNED` refuses the bootstrap superuser), done in a quiet window.
- Database passwords live in `deploy/.env` (compose interpolation). The web container's `env_file` (`../.env`) holds app secrets only; web gets just the DML URLs, and only `db` and `migrate` see owner or bootstrap passwords.

Postgres runs `prod-initdb` only on a fresh data volume. **On an existing volume, in this order:**
1. Add `CHECKIN_DML_DB_PASSWORD` (and each library's `<NAME>_OWNER_DB_PASSWORD` / `<NAME>_DML_DB_PASSWORD`, if not yet set) to `deploy/.env`; remove every `*_DB_PASSWORD` from `../.env`.
2. Recreate only the database container so it sees the new passwords: `docker compose -f deploy/docker-compose.prod.yml up -d --no-deps db` (a short restart; web reconnects).
3. Run the bootstrap once (both scripts are idempotent, so re-running is safe): `docker compose -f deploy/docker-compose.prod.yml exec db sh -c 'for f in /docker-entrypoint-initdb.d/*.sh; do sh "$f" || exit 1; done'`.
4. Verify before switching: `docker compose -f deploy/docker-compose.prod.yml exec db psql -h 127.0.0.1 -U checkin_dml -d checkmein -c 'SELECT count(*) FROM "Person"'` succeeds, and the same login against `-d postgres` is refused.
5. Only now recreate web, which picks up the `checkin_dml` URL: `docker compose -f deploy/docker-compose.prod.yml up -d web`.

Rollback: point web's `DATABASE_URL` back at the bootstrap user and `up -d web`. The roles and grants are additive and can stay. Never switch the URL first: until step 3 the role does not exist, and every request fails to connect.

**Baseline before the first `migrate` run on a volume built by `prisma db push`.** Such a database has checkin's tables but no `_prisma_migrations` ledger, so `prisma migrate deploy` refuses it with `P3005` ("the database schema is not empty"). Once, before the first `docker compose -f deploy/docker-compose.prod.yml --profile migrate run --rm migrate`, using the image of the release the volume was last pushed from:
1. Confirm the database matches that release's schema; this must print no diff: `docker compose -f deploy/docker-compose.prod.yml --profile migrate run --rm migrate sh -c 'cd checkin-app && npx --no-install prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --exit-code'`. Any diff means the volume is not at that release; stop and reconcile by hand.
2. `db push` cannot create the partial unique indexes that migrations add in raw SQL. Copy each `CREATE UNIQUE INDEX ... WHERE` statement from `checkin-app/prisma/migrations/*/migration.sql` that is missing from `pg_indexes`, and run it as the bootstrap user.
3. Record every migration as applied: `docker compose -f deploy/docker-compose.prod.yml --profile migrate run --rm migrate sh -c 'cd checkin-app && for m in prisma/migrations/*/; do npx --no-install prisma migrate resolve --applied "$(basename "$m")" || exit 1; done'`.

After that, `migrate` runs normally on every deploy. A fresh volume needs none of this.

## How to verify

- **`migration-safety.yml`** (added in #794, after the 2026-07-02 incident) applies the PR's new migrations on top of a **seeded, populated** database — not the always-empty DB that local dev and CI's own drift check use. It catches "this migration fails/loses data on a populated table" (the class of bug rules 4–5 exist for). It does **not** and cannot catch deploy-*sequencing* hazards — whether the migration is compatible with the code currently running in prod during the drain window (rules 1–3). A green check here is necessary, not sufficient; the #917 critical finding shipped with this check fully green.
- The CI drift check (`ci.yml` → "Check migrations match schema") only proves the migration files reproduce `schema.prisma` on an **empty** DB — it exercises none of the populated-DB or sequencing concerns above.
- What still needs human judgment on every migration PR: is anything destructive, and if so, has the reader/writer cutover it depends on already fully rolled out in a prior release? That's the one check no CI job can perform, because it requires knowing what's actually running in production right now — the [migration-safety skill](../../.claude/skills/migration-safety/SKILL.md) turns the rules above into the checklist to run that judgment against.
