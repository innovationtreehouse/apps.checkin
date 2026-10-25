# Cutover: duplicate receipts as groups

The one-time part of `2516_RECEIPT_DUPLICATES.md`: the build order, the tests
that change, and what happens to receipts already in the database. Everything
here stops being true once the last PR merges. Its last step is "extract the
rules, delete both files".

## Where it stands

- Designed; no open question settled yet (design §10).
- #2515 pins today's behaviour in ten DB-tier tests
  (`packages/receipt/src/__tests__/integration/three-copies.test.ts`). It is
  another session's draft. It merges as it is; PR 1 below flips its tests.
- #2561 (retailer case and spaces) is merged. #2558 (fuzzy retailer) is open
  and not part of this plan.

## Build plan

Each PR is small and test first: the flipped test lands failing (`it.fails`)
in the PR before the one that makes it pass, or in the same PR when the change
is small. PRs 3, 4 and 7 depend on @thpr's answers to the questions named.

| PR | Kind | What | Needs |
| --- | --- | --- | --- |
| 1 | test | Flip #2515's ten tests to the decided behaviour (table below), marked `it.fails`; add tests for the earlier copy meeting the guard (§5.2) and for re-check after discard (§6.4) | #2515 merged |
| 2 | mig | Add the pair-decision table (expand only: a new table, nothing dropped). Fill it from today's cleared receipts per Q10 | Q10 |
| 3 | app | Group query: every tier, symmetric, transitive, ordered by upload time; discarded rule per Q1; rejected marker. The pipeline guard uses it. `duplicateFlagClearedAt` stops exempting | Q1 |
| 4 | security boundary, then app | Registry entry for the group decisions if they need a new route verb (land first, per `AGENTS.md`), then **Not this one** per match (with undo), **Different purchases**, **Keep this one**, re-check after a decision, the note rule | Q2, Q7, Q12 |
| 5 | app | N-way compare panel (extends #2549) with the per-column dismiss, dismissed strip and redraw, one queue row per group, the badge on open members, the submitter's message | Q6 |
| 6 | app | Date and number normalisation, and the editor's date input; the similar-date tier if Q13 says yes | Q3, Q13 |
| 7 | app | Posting re-check: the receipt push carries decided-different receipt ids (contract change in `receipt-types`), the derived QuickBooks-tab reason, the outbox skip, and the stop action | Q8, Q9 |
| 8 | ops + docs | One-time list of finalized groups for finance (Q11); extract design §9's accepted rules into `docs/rules/expenses.md`; delete both files | all |

## #2515's tests, flipped

| # | Test today | Decided behaviour |
| --- | --- | --- |
| 1 | Same file three times: B and C flagged against A | Unchanged in outcome; assert B's and C's group is {A, B, C} in upload order, not a stored suspect |
| 2 | Same fields: C flagged against A or B | C's group is {A, B}, always in that order |
| 3 | C cleared against A goes through beside cleared B | C's compare shows B; clearing C records C≠A and C≠B, which finance saw |
| 4 | Two cleared field copies never compared | Each copy's group contains the other until a decision covers that pair |
| 5 | A discarded to keep B; C flagged against discarded A, clears beside B | "Keep this one" on B discards A; C's group shows live B (and A greyed); C cannot finalize without a decision against B |
| 6 | Copies after A was discarded flag against A, both clear | Per Q1(a), A alone raises nothing; B and C flag against each other |
| 7 | Copies of a rejected A flag against it, both clear | Flagged with the rejected marker; clearing needs a note (Q7); B and C are in one group |
| 8 | Re-upload of B's file flagged against B, not A | C's group is {A, B} |
| 9 | C's copy B discarded; C clears beside A | C's group still holds live A; C stays held until decided against A |
| 10 | C's copy B cleared; C stays flagged against finalized B | Unchanged in outcome; group is {A, B} |

The 1265 race test ("two identical uploads at once, exactly one ends
`duplicate_flagged`") keeps passing: the insert lock stays.

## Data already in the database

- **Cleared receipts** (`duplicateFlagClearedAt` set): per Q10.
- **Finalized groups**: per Q11, a one-time list for finance. Posted pairs can
  only be fixed in QuickBooks; unposted ones are caught by PR 7's hold.
- **`duplicateSuspectReceiptId`**: kept, unread by the check after PR 3. A
  later contract migration may drop it with `duplicateFlagClearedAt`.

## Last step

Extract the rules design §9 lists that @thpr accepted into
`docs/rules/expenses.md`, then delete `2516_RECEIPT_DUPLICATES.md` and this
file.
