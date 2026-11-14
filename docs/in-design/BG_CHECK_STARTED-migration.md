# Cutover: "check started" moves off the household application

Everything here expires once the change has run. The design is in
`BG_CHECK_STARTED.md`.

## Where it stands

Nothing is built. The household application still records the flag. Three paths
write it:

- the applicant self-report;
- the Board's `mark-bg-consent` action;
- the dev mock.

Settle opens a review naming nobody off that flag, and the advance to payment and
the resume after a block both read it.

Open applications in production may already carry the household flag. Some have a
review naming nobody open because of it, and some do not. How many is not stated
here; the exit check below counts them when it matters.

## Schema and data

- **No migration.** The column stays as it is: no rename, no drop, no new column
  and no backfill. Nothing in this work drops data.
- **No data step.** A household flag cannot be turned into a person-level one: the
  click never said whose check it was. Old rows are read as they stand, through the
  legacy clause below.
- **Old code during the deploy drain.** Pods still on the old release may write the
  household flag through the old paths until they drain. The legacy clause reads
  any such row exactly like one written before the cutover, so nothing is lost. A
  browser still holding the old /membership page gets a 404 from the deleted
  self-report route. A reload shows the new panel.

## The legacy clause

Until the exit condition holds, an open INITIAL or RENEWAL application whose own
`bgConsentAt` is set counts as "check started" in three places:

1. **The advance gate.** `householdCheckStarted` also returns true when the open
   application carries the flag.
2. **Where a lifted block resumes.** `blockedResetStatus` gets the same derived
   `true`.
3. **Settle and the daily sweep.** These still open a review naming nobody for such
   an application, under today's conditions: no lead cleared or pending, nobody
   disputed, no review already open for the household. This is today's
   `openRequestedReview`, now keyed only on the legacy flag, so a family that
   consented before the cutover is not left with nothing in the queue.

All three read one helper, `legacyHouseholdCheckStarted(app)`, so the follow-up PR
deletes one function and its callers.

**Exit condition.** No open INITIAL or RENEWAL application has `bgConsentAt` set and
`bgClearedAt` null. Read-only check, run against production by whoever lands the
follow-up PR:

```sql
SELECT count(*) FROM "OrgMembershipProcess"
WHERE kind IN ('INITIAL','RENEWAL') AND "bgConsentAt" IS NOT NULL
  AND "bgClearedAt" IS NULL
  AND status IN ('INTAKE','PENDING_EXTERNAL_ACTION','PENDING_BG_REVIEW','PENDING_PAYMENT',
                 'PENDING_BG_CLEARANCE','BLOCKED','PENDING_RENEWAL','RENEWAL_PENDING_BG');
```

The status list must match `openProcess` in `checkin-app/src/lib/membership/lifecycle.ts` at the
time it is run. Re-read it there; do not trust this copy.

Applications clear, finish or are closed in the normal course of things. A few
stuck ones are a Board conversation, not a reason to keep the clause.

## Pull requests, in order

No PR is stacked on another. Each is based on `main` after the one before it has
merged. Confirm a merged PR's files are on `main` (`git show origin/main:<path>`)
before starting the next.

1. **Boundary: register the family route.** Registry entries only:
   - `GET` and `POST /api/membership/check-started` in the registry, with role and
     token grants for any signed-in person. The handler narrows the subject to whom
     the caller may mark (D4).
   - `POST /api/membership/reviews/dismiss`, with
     `authorize: { anyRole: ['isBackgroundCheckReviewer', 'isBoardMember'] }`, as
     for `POST /api/membership/reviews/undo` (CS-4).
   - The view for the synthetic `state` field, and its classification if the
     registry needs one.

   It ships no route file. The route-coverage lint treats a registry entry with no
   route file as the sanctioned register-first state: it warns and does not block.
   Only security tests (`checkin-app/src/security/__tests__/`) may accompany it.
2. **App: build it.** Everything in the design file:
   - `markCheckStarted`, `dismissCheckStarted` and `householdCheckStarted`, plus
     the legacy clause.
   - The advance gate, `blockedResetStatus` and settle changes.
   - The new route files, including the dismissal route.
   - The /membership panel and the Board applications page.
   - The dev mock.
   - Removal of the `mark-bg-consent` action.
   - Deletion of `POST /api/membership/bg-consent` and its line in
     `checkin-app/scripts/legacy-authz-routes.txt`.
   - The wording changes and the schema comment on `bgConsentAt`.

   In the same PR, per `DOCUMENTATION_STANDARD.md` §3.7 and §4:
   - Apply the "Rule text" section of the design file to
     `docs/rules/membership.md`.
   - Apply the **Consent** rows to `docs/VOCABULARY.md`.
   - Update the consent wording in `docs/ops/background-check-mock.md` where it
     means the app's record rather than the outside tool.
   - Delete `BG_CHECK_STARTED.md`.
   - Trim this file to the legacy clause and step 3.

3. **App: drop the legacy clause** once the exit condition holds:
   - Delete `legacyHouseholdCheckStarted` and its three callers.
   - Delete `openRequestedReview`.
   - Narrow the sweep to re-settle only.
   - Remove the rule sentence about the legacy clause, if one was written.
   - Delete this file.

   No migration: the column and its old values stay as history.

## Last step

When step 3 merges: the rules are already in `docs/rules/membership.md` and
`docs/VOCABULARY.md` from step 2. Delete this file.
