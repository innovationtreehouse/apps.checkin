# Cutover: "check started" moves off the household application

Everything here expires once the change has run. The rules are in
`docs/rules/membership.md` (*Background checks for individual adults*) and
`docs/VOCABULARY.md` (**Consent**, **Check started**).

## Where it stands

"Check started" is recorded on each person's own check review. The household
application no longer records it, and nothing writes the household flag any more.
Open applications in production may still carry it from before the cutover; the
legacy clause below reads them. The Board's close-as-wrong-person and its reopen
(Board ruling B27) are built.

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
`bgClearedAt` null. The System Status page shows the count, in the row
"Applications on the old household check flag"
(`checkin-app/src/lib/membership/legacyCheckFlagHealth.ts`, which reads the open
statuses from `openProcess`). Step 3 can land once it reads 0. Nobody runs a query
against production for this.

Applications clear, finish or are closed in the normal course of things. A few
stuck ones are a Board conversation, not a reason to keep the clause.

## Pull requests, in order

No PR is stacked on another. Each is based on `main` after the one before it has
merged. Confirm a merged PR's files are on `main` (`git show origin/main:<path>`)
before starting the next. Steps 1 (the boundary PR), 2 (the app build) and 2b (the
Board's close-as-wrong-person) have merged.

3. **App: drop the legacy clause** once the exit condition holds:
   - Delete `legacyHouseholdCheckStarted` and its three callers.
   - Delete `openRequestedReview`.
   - Narrow the sweep to re-settle only.
   - Delete the System Status row `legacyCheckFlagHealth.ts`, its test and its line in the
     config-health route.
   - Remove the rule sentence about the legacy clause, if one was written.
   - Delete this file.

   No migration: the column and its old values stay as history.
