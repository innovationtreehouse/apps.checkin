---
name: migration-safety
description: >-
  Runnable checklist for schema migrations vs. the deploy sequence — old code
  keeps serving live traffic against the fully-migrated schema for the whole
  rolling-deploy drain window, so a migration safe on its own can still break
  prod. TRIGGER on any of: an added or edited file under
  checkin-app/prisma/migrations/; a schema.prisma edit that drops or renames a
  model/field, or adds NOT NULL to an existing column; task text containing
  "migration", "DROP TABLE", "SET NOT NULL", or "squash". AUTO-FIRE alongside
  safe-refactor-sweep when a schema/migration edit also renames or removes
  something — run both checklists, they catch different failure classes.
---

# migration-safety

The authority for every rule below is
[`docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`](../../../docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md)
— read it once for the why; this is the checklist version for every migration
PR. It exists because PR #917 shipped a `DROP TABLE` in the same release as
its backfill while `origin/main`'s JWT callback read that table on every
authenticated request — CI was fully green, and the whole drain window would
have 500'd site-wide. `migration-safety.yml` (the populated-DB CI job) cannot
catch that class of bug; only this checklist can, because it requires knowing
what code is running in prod right now, not just what's in this PR.

## The checklist — run every step that applies

### 1. Is anything in this migration destructive?
`DROP TABLE` / `DROP COLUMN`, `SET NOT NULL` on a column old code might still
write null to, a rename of anything old code touches.

- **No** → expand-only (additive column/table/index/backfill) is fine to ship
  with the code that uses it. Stop here.
- **Yes** → does *this same PR* also contain the expand/backfill stage it
  depends on? If so, **split it**: ship expand + cutover now, the destructive
  step in a follow-up PR only after the cutover code is fully rolled out.
  Exception: you can ship both together only if you can prove no live code
  path (old or new) can ever violate the new constraint — e.g. #918's
  `Household.name SET NOT NULL` shipped in one migration because every write
  path already always wrote a name. If you can't make that case in the PR
  description, split the release.

### 2. Grep every non-TS reader/writer, not just the TypeScript ones
A schema change isn't cut over until these are all updated too — #917's own
cutover sweep missed the first one:
```
grep -rn '<OldModelOrTable>' checkin-app/scripts/*.sh
grep -rn '<OldModelOrTable>' docs/VOCABULARY.md
grep -rn 'tableName: "<OldModelOrTable>"' checkin-app/src   # audit-log literals
grep -rn '<OldModelOrTable>' checkin-app/prisma/seed.ts
```

### 3. Is this a rename?
Prisma's diff engine has no `RENAME` primitive — a generated "rename" is
`DROP COLUMN`+`ADD COLUMN` or `DROP TABLE`+`CREATE TABLE`. Passes on every
empty CI/local DB, then hard-fails (`23502`) or silently drops data on a
populated one. This wedged dev for a day on 2026-07-02 (fixed in #791). Never
ship a generated rename — hand-write it:
```sql
ALTER TABLE "Old" RENAME TO "New";
ALTER TABLE "Foo" RENAME COLUMN "old" TO "new";
ALTER TABLE "Foo" RENAME CONSTRAINT "old_pkey" TO "new_pkey";
ALTER INDEX "old_idx" RENAME TO "new_idx";
```

### 4. Does this migration have more than one statement that must succeed together?
Prisma does **not** wrap a migration file in a transaction on Postgres
(`prisma/prisma#15295`) — a multi-statement migration can partially apply
(2026-07-02: one table's `ALTER` committed, the sibling's rolled back, and it
took manual surgery to recover). Wrap it:
```sql
BEGIN;
-- ...both statements...
COMMIT;
```
Every new migration wraps, even a single statement: CI fails a newly added
file that does not open with `BEGIN;` and close with `COMMIT;`
(`migration-safety.yml` → "New migrations wrap in a transaction"). For SQL that cannot run in a
transaction (`CREATE INDEX CONCURRENTLY`), add `-- no-transaction: <reason>`
and make each statement retry-safe instead; see the deploy doc's rule 5.

### 5. New foreign key or flag you'll query by?
Postgres does not auto-index FK columns. Add `@@index` for any relation
scalar (or new flag) a hot path will filter/join on, in the same migration —
PR #917 skipped this on `Person.householdId` and turned an indexed lookup
into a full seq-scan.

### 6. Is a schema-PR already open elsewhere?
Same-timestamp migrations from two open PRs interleave lexicographically at
deploy time. Check what order the two sets of timestamps put them in once
both land — don't assume it's harmless without checking (it happened to be,
for #917/#918, verified with `git merge-tree`; that's a check, not a given).

### 7. Field visibility changed?
New or renamed field needs `/// @sensitivity:<tier>` in `schema.prisma` with
`classifications.ts` regenerated and committed — CI/CODEOWNERS-enforced, easy
to forget mid-migration. See `docs/security/SECURITY-POLICY.md`.

### 8. Green `migration-safety.yml` ≠ deploy-safe
That CI job (populated-DB check) proves the migration *applies* to a real
database. It says nothing about steps 1 or 2 above — a migration can pass it
and still break prod during the drain window. Don't treat green CI as
"done"; treat it as "the populated-DB half of done."

### 9. Did a migration already fail on some environment?
A failed migration blocks every future deploy with `P3009` until resolved:
```
npx prisma migrate resolve --rolled-back <name>   # didn't apply — default
npx prisma migrate resolve --applied <name>        # only after manually verifying schema state
```
Run via the one-off ECS migrate task (DB is VPC-only — same pattern
`deploy-dev.yml`/`deploy-prod.yml` use, not reachable from a laptop). A
squash-style migration PR (like #792) legitimately fails the populated-DB
check on every already-migrated database and needs the same
`DELETE FROM "_prisma_migrations"` + `resolve --applied <baseline>` treatment
on each one — that's expected, not a sign something's broken.

## Done criteria
- [ ] Destructive change, if any, is either split into a follow-up release or
      justified in the PR description as provably safe to ship together
- [ ] Non-TS readers/writers grepped to zero (scripts, VOCABULARY.md, audit
      `tableName` literals, seed.ts)
- [ ] Any rename is hand-written SQL, not Prisma-generated DROP+ADD
- [ ] Multi-statement migrations wrapped in `BEGIN;`/`COMMIT;`
- [ ] New queried FK/flag has `@@index`
- [ ] Cross-PR migration timestamp ordering checked if another schema PR is open
- [ ] `@sensitivity` + regenerated `classifications.ts` if fields changed
- [ ] `migration-safety.yml` green — understood as necessary, not sufficient
