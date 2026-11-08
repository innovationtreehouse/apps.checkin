# Cutover: capital as a decision

The one-time part of `CAPITAL_AS_DECISION.md`: what happens to the records that
exist, the order of the PRs, and what each must be safe against. Everything here
stops being true once the last PR merges. Its last step is "extract the rules,
delete both files".

## Where it stands

- Designed, not built. Every owner question, CAD-1 to CAD-16, is settled.
  CAD-8's removal and the CAD-13 conventions are their own PRs, not steps here.
- The counts of existing rows in each environment are not known here. The
  backfill in step 3 reports them before it changes anything, and its dry run is
  the first thing to run per environment.

## Existing records

| Record | Where | What happens |
|---|---|---|
| `DonatedCapitalLine` with `isCapital` true or false | expense database | Its decision, period, owner, reviewer and time are written onto the gift line it names (`giftSource`, `giftId`, `giftLineId`); a capital line whose copy already has assets gets `registeredAt` from the first asset's creation. Cross-database, so a script, not a SQL migration. |
| `DonatedCapitalLine` with `isCapital` null | expense database | The gift is marked as needing review and its lines keep `isCapital` null. The gift keeps waiting on capital, now on its own page. |
| An accepted gift with no copy | bulk-donation database | Sent but under the thresholds: needs no review. Never sent (`capitalSubmittedAt` null): the shared threshold test runs once and records whether it needs review. |
| A refused or returned gift, or one flagged withdrawn | bulk-donation database | Needs no review. A gift flagged withdrawn should not exist (B13); any found is listed for finance with its assets, not changed by the script. |
| `CapitalAsset` with `sourceDonatedLineId` | expense database | `sourceKind = gift_line` and the three gift columns set from the copy it points at. Same database: a SQL data migration. `unitIndex` by id order within the line. |
| `CapitalAsset` with `sourceLineItemId` | expense database | `sourceKind = expense_line`; `unitIndex` by id order. |
| `CapitalAsset` seeded | expense database | Untouched: its number is the item's label (CAD-12). `sourceKind` stays null until finance links a backfilled line to it. |
| A backfilled expense's minted asset that duplicates a seeded one (B8) | expense database | Listed for finance with the seeded row it may duplicate. Neither number changes and the script deletes nothing. |
| Asset numbers deleted by past clearings | expense audit log | Numbers are physical labels and are never reused. The `capital_asset_cleared` rows name every number deleted so far. They are read twice, by migration only: to set each org's high-water mark in step 2, and again in step 3 to cover the drain. No app code reads them. A number already reissued (B7) is listed for finance, not changed. |

## Order

Expand, then switch, then contract. Old code keeps serving for the whole deploy
drain against the migrated schema, so no step removes anything the previous
release reads.

1. **Schema, additive.** Nullable gift-line capital columns and the gift's
   `capitalReviewNeeded` in bulk-donation; nullable `sourceKind`, gift source
   columns and `unitIndex` on `CapitalAsset`. The unique index on (org, source,
   unit index) is created only after step 3 fills it. Safe against old code:
   nothing it writes conflicts.
2. **High-water mark and register; expense capital becomes final.** The
   migration adds `CapitalAssetSequence` and sets each org's mark to the highest
   of the register and the cleared numbers in the audit log. While old and new
   releases both serve, the new code takes the next number as one more than the
   higher of the mark and the register's highest, so a number an old release
   mints is never issued again. Expense gains `register`;
   both mint paths go through it and fill the new columns. The capital steps do
   not open while the reimbursee is unknown, and the send-back edges out of
   them, with the asset deletion, go. The gift path still copies, and **at
   accept** also records whether the gift needs review, from the shared test.
   One PR, expense and bulk-donation.
3. **Backfill, after step 2 has fully rolled out.** Not before: until then an
   old release can still mint assets with no `sourceKind`, which the backfill
   would miss and `register` would mint again, or delete one. The script above,
   idempotent, with a dry run that prints the counts per row of the table and
   the lists for finance. It raises each mark once more from the audit log, to
   cover any number an old release minted and deleted during the drain. Then
   the unique index, and the next-number read drops the register scan and reads
   the mark alone.
4. **The review module.** The two purchase steps' logic moves into the shared
   module behind the line store; the purchase routes bind it and behave as
   before. Expense only.
5. **Boundary PR: the two gift capital routes.** Their registry entries alone,
   in `checkin-app/src/security/`, per the boundary isolation rule. Inert until
   step 6.
6. **Switch.** The gift page takes the two capital steps; the drain registers
   and stamps; a gift waits for its stamps before it books; booking reads the
   gift line. The copy stops being written; the Donated Equipment page and nav
   entry go. Based on `main`, not on step 5's branch. Until step 7, the drain
   also takes the review of any copy reviewed after the step 3 backfill: a gift
   line with `isCapital` null whose copy holds a review gets that review, with
   its audit events, before the gift is shown as waiting on capital.
7. **Contract, decommission.** Drop `DonatedCapitalLine`,
   `CapitalAsset.sourceDonatedLineId`, `capitalSubmittedAt`, the two
   `donated-capital` routes and their registry entries, and the `submit`,
   `awaitingReview` and `assetLineIds` port methods. Shipped under the
   decommission exception in `docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
   rule 7, only after step 6 has been deployed to production.
8. **Extract the rules, delete both files.** The settled candidates in section
   6 of the design go into `docs/rules/expenses.md`.

## What each step must be safe against

- Step 2 against step 1's old code: an old release still mints by scanning the
  register and can still send an expense back and delete its assets during the
  drain. New mints read the higher of the mark and the register, so they never
  collide with an old mint; a number an old release mints and then deletes is
  caught by step 3's second read of the audit log, before anything relies on the
  mark alone.
- Step 6 against step 4's code: an old release still copying lines while the
  new one reads the gift line. The copy is ignored by the new reads and dropped
  in step 7.
- Step 7 only after no release that reads `DonatedCapitalLine` is serving.
