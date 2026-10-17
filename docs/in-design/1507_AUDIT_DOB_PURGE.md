# Purge date of birth from audit-log JSON (#1507)

## Problem

When a person crosses age 26, the nightly cron purges `Person.dateOfBirth` and
the write-time guard (`normalizeAdultDob`) prevents re-entry. But
`AuditLog.oldData` / `newData` — untyped JSON columns — still hold the date of
birth from edits made before or after the purge. The original requirement was
"deep delete — no record of it." The audit half was never completed.

The residue is not one-time: a 17-year-old's member-edit today legitimately
records their DOB. Nine years later the nightly cron purges the `Person` row,
but the audit blob still holds it. New residue accrues continuously as people
age past 26.

## Objective

No audit row holds a date of birth for anyone whose `Person.dateOfBirth` is
null (i.e. purged). This is both a retroactive cleanup (historical residue) and
a durable invariant (no new DOB enters audit going forward).

## Executive summary

- **Durable fix (option A):** strip `dateOfBirth` from the object before it
  enters `newData`/`oldData` at every `tableName: "Person"` audit site that
  currently includes it. Three sites need changes; ten are already safe.
- **One-time migration:** a data migration removes `dateOfBirth` from historical
  audit JSON for any person whose `Person.dateOfBirth` is currently null.
- **What does not change:** audit rows themselves are never deleted; only the
  one key is stripped.

---

## Decision: option A over option B

**Option A — stop writing DOB to audit blobs.** If the key never enters audit,
nothing can outlive anything. The invariant is structural: there is no window
between a write and a scrub in which the data exists.

**Option B — extend the nightly purge** to scrub audit JSON alongside the
`Person` column. Preserves audit fidelity (the blob records what the form
actually saved at the time).

**Option B-hybrid — keep the pre-image, scrub at purge time.** A variant of B
that writes the full pre-image (including DOB) into audit at edit time, then
strips it when the nightly cron purges `Person.dateOfBirth`. While a person is
under 26, DOB is live on `Person` anyway — readable more widely than audit
readers — so the pre-purge window adds no exposure the Person row doesn't
already carry. This satisfies both the "no record" requirement (post-purge,
audit holds nothing) and the principles register's "capture the pre-image
before acting."

**Recommendation: A.** The requirement was "no record of it." A structural
invariant (never written) is stronger than a runtime scrub (written, then
erased). The B-hybrid variant has a real argument — it preserves audit fidelity
for the period when the DOB is live anyway, and aligns with the pre-image
capture principle. **That tension is Principle-tier; escalate to the owner
rather than settling it here.** If the owner prefers B-hybrid, the migration
and inventory work below are unchanged; only the write-time stripping reverses,
and a nightly-cron scrub step is added instead.

The nightly cron already logs `{ field: 'dateOfBirth', reason:
'aged_out_over_25' }` as a record that a purge happened, without recording the
value itself.

---

## Affected audit sites

All `auditLog.create` calls with `tableName: "Person"` were audited — 13
sites across 9 files. Three write DOB; ten are already safe.

### Needs fix

| File | What goes into audit | Fix |
|------|---------------------|-----|
| `src/app/api/household/member/route.ts` (EDIT) | `newData: updatedHouseholdMember` — selected via `HOUSEHOLD_PEER_SELECT`, which includes `dateOfBirth` | Destructure out `dateOfBirth` before writing |
| `src/app/api/profile/route.ts` (EDIT) | `newData: updatedProfile` — select includes `dateOfBirth` | Destructure out `dateOfBirth` before writing |
| `src/app/api/membership-ops/participants/merge/route.ts` (DELETE) | `oldData` embeds `personPreImage()` which captures `dateOfBirth` | Strip from `personPreImage` return |

### Already safe

| File | Why safe |
|------|---------|
| `src/app/api/household/route.ts` (EDIT) | Writes `{ householdId, email, name }` — no DOB |
| `src/app/api/household/member/route.ts` (CREATE) | Lead promote within edit tx — writes `{ participantId }` only |
| `src/app/api/household/member/route.ts` (DELETE) | Lead demote within edit tx — writes `{ participantId, secondaryAffectedEntity }` only |
| `src/app/api/household/lead/route.ts` (CREATE) | Writes `{ householdId, participantId, isHouseholdLead }` — no DOB |
| `src/app/api/household/lead/route.ts` (DELETE) | Writes `{ householdId, personId, isHouseholdLead }` — no DOB |
| `src/app/api/roles/route.ts` (EDIT) | Writes `{ canAccessStaging }` — staging-access toggle, no person fields |
| `src/app/api/membership-ops/participants/[id]/route.ts` (EDIT) | Already destructures out DOB: `const { dateOfBirth: priorDob, ...prior }` |
| `src/app/api/membership-ops/participants/[id]/household/route.ts` (EDIT) | Writes `{ householdId }` only |
| `src/app/api/membership-ops/contacts/route.ts` (CREATE) | Writes `{ name, email }` — no DOB |
| `src/app/api/cron/nightly/route.ts` (DELETE) | Writes `{ field: 'dateOfBirth', reason: 'aged_out_over_25' }` — the event, never the value |

---

## Durable fix: strip DOB at write time

The pattern at each site: destructure `dateOfBirth` out of the object before
passing it to `newData` or `oldData`.

```ts
// Before:
newData: updatedHouseholdMember

// After:
const { dateOfBirth: _dob, ...auditData } = updatedHouseholdMember;
// ...
newData: auditData
```

### Site 1: `household/member/route.ts`

`updatedHouseholdMember` comes from a `person.update(..., select: HOUSEHOLD_PEER_SELECT)`.
Destructure before the `auditLog.create` that writes `newData: updatedHouseholdMember`.

### Site 2: `profile/route.ts`

`updatedProfile` comes from `person.update` with a select including `dateOfBirth`.
Destructure before the `auditLog.create` that writes `newData: updatedProfile`.

### Site 3: `membership-ops/participants/merge/route.ts`

`personPreImage()`, a module-level function in that file, explicitly lists `dateOfBirth: p.dateOfBirth`.
Remove that line from the function. This strips DOB from both the merge-target
and the keeper pre-images in `oldData`.

---

## One-time migration: historical residue

Ship as a Prisma migration. Irreversible by design — "no record of it" demands
exactly that.

```sql
-- Strip dateOfBirth from newData where the Person's DOB has since been purged.
UPDATE "AuditLog" a
   SET "newData" = a."newData" - 'dateOfBirth'
  FROM "Person" p
 WHERE a."tableName" = 'Person'
   AND a."affectedEntityId" = p.id
   AND p."dateOfBirth" IS NULL
   AND a."newData" ? 'dateOfBirth'
   AND a."newData"->>'dateOfBirth' IS NOT NULL;

-- Strip dateOfBirth from oldData.
-- For merge-audit rows, affectedEntityId is the KEEPER while top-level
-- oldData is the LOSER's pre-image. Join on the embedded id (which
-- personPreImage always writes) to match the correct Person row.
UPDATE "AuditLog" a
   SET "oldData" = a."oldData" - 'dateOfBirth'
  FROM "Person" p
 WHERE a."tableName" = 'Person'
   AND a."oldData" ? 'dateOfBirth'
   AND a."oldData"->>'dateOfBirth' IS NOT NULL
   AND a."oldData"->>'id' IS NOT NULL
   AND p.id = (a."oldData"->>'id')::int
   AND p."dateOfBirth" IS NULL;

-- Merge route nests a `keeper` object inside oldData that also carries DOB.
-- Strip it from the nested object for rows where the keeper's DOB is purged.
UPDATE "AuditLog" a
   SET "oldData" = jsonb_set(
       a."oldData",
       '{keeper}',
       (a."oldData"->'keeper') - 'dateOfBirth'
   )
  FROM "Person" p
 WHERE a."tableName" = 'Person'
   AND a."oldData"->'keeper' ? 'dateOfBirth'
   AND a."oldData"->'keeper'->>'id' IS NOT NULL
   AND p.id = (a."oldData"->'keeper'->>'id')::int
   AND p."dateOfBirth" IS NULL;
```

**Properties:**
- Self-sizing: no-op when nothing matches. Safe to run on any environment.
- Idempotent: re-running changes nothing (the WHERE clause requires the key to
  exist with a non-null value).
- Preserves all other audit fields and the row itself.
- A youth whose DOB is legitimately still on their `Person` row is untouched —
  the `p."dateOfBirth" IS NULL` join ensures only purged people are affected.

**Sequencing constraint:** this migration joins on `"Person" p` to check
whether a person's DOB has been purged. Once the tombstone-removal work
(`TOMBSTONE_REMOVAL.md`) deletes Person rows, those joins match nothing and
orphaned audit residue becomes unreachable. **This migration must run before
the tombstone delete phase**, or be rewritten to key off the archive snapshot
instead of the live Person table.

**Precedent:** `20260724120000_purge_adult_dob` was itself a one-time data fix
shipped as a migration.

---

## Open questions

1. **Option A vs B-hybrid — Principle-tier escalation.** The pre-image capture
   principle applies here: option A discards information the audit trail is
   designed to preserve. The exposure argument (DOB is already live on Person
   while under 26) makes B-hybrid defensible. This is a Principle-tier tension
   that the owner should decide before implementation proceeds.

2. **Historical merge nesting patterns.** The merge route currently stores
   `{ ...personPreImage(merged), keeper: personPreImage(keeper) }`. If earlier
   versions of the merge code used a different nesting shape, the migration's
   statement 3 would miss those rows. A pre-run verification query:
   ```sql
   SELECT count(*) FROM "AuditLog"
    WHERE "tableName" = 'Person'
      AND "oldData"::text LIKE '%dateOfBirth%'
      AND "oldData" ? 'keeper';
   ```
