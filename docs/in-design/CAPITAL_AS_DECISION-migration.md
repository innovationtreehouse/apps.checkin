# Cutover: capital as a decision

The one-time part of `CAPITAL_AS_DECISION.md`: what happens to the records that
exist, the order of the PRs, and what each must be safe against. Everything here
stops being true once the last PR merges. Its last step is "extract the rules,
delete both files".

## Where it stands

- Designed, not built. Waiting on CAD-1 to CAD-8 and CAD-10 to CAD-11. CAD-9
  and CAD-12 do not block the build order below.
- The counts of existing rows in each environment are not known here. The
  backfill in step 3 reports them before it changes anything, and its dry run is
  the first thing to run per environment.

## Existing records

| Record | Where | What happens |
|---|---|---|
| `DonatedCapitalLine` with `isCapital` true or false | expense database | Its decision, period, owner, reviewer and time are written onto the gift line it names (`giftSource`, `giftId`, `giftLineId`) as `capital` or `not_capital`. Cross-database, so a script, not a SQL migration. |
| `DonatedCapitalLine` with `isCapital` null | expense database | The gift line becomes `pending`. The gift keeps waiting on capital, now on its own page. |
| An accepted gift's line with no copy | bulk-donation database | Under the thresholds when it was sent: `not_needed`. A gift never sent (`capitalSubmittedAt` null): the shared threshold test runs and sets `pending` or `not_needed`. |
| A refused, returned or settled-withdrawn gift's line | bulk-donation database | Left without a capital state. A settled-withdrawn gift with assets is listed for finance (CAD-8), not changed by the script. |
| `CapitalAsset` with `sourceDonatedLineId` | expense database | `sourceKind = gift_line` and the three gift columns set from the copy it points at. Same database: a SQL data migration. `unitIndex` by id order within the line. |
| `CapitalAsset` with `sourceLineItemId` | expense database | `sourceKind = expense_line`; `unitIndex` by id order. |
| `CapitalAsset` seeded | expense database | `sourceKind` stays null. Untouched. |
| Asset numbers deleted by past clearings | expense audit log | The `capital_asset_cleared` rows name them. Under CAD-7 "retired for good", the highest ever issued is read from the register **and** those rows, so a deleted number is not issued again. A number already reissued (B7) is listed for finance, not changed. |

## Order

Expand, then switch, then contract. Old code keeps serving for the whole deploy
drain against the migrated schema, so no step removes anything the previous
release reads.

1. **Schema, additive.** Nullable gift-line columns in bulk-donation; nullable
   `sourceKind`, gift source columns and `unitIndex` on `CapitalAsset`, and the
   `retired` status. The unique index on (org, source, unit index) is created
   only after step 3 fills it. Safe against old code: nothing it writes
   conflicts.
2. **Register service and dual write.** Expense gains `register`, `retire` and
   `assetsOf`; both mint paths go through `register` and fill the new columns.
   Clearing an expense retires instead of deleting. The gift path still copies,
   and also writes the decision on its line when finance reviews the copy. One
   PR, expense and bulk-donation.
3. **Backfill.** The script above, idempotent, with a dry run that prints the
   counts per row of the table and the lists for finance. Then the unique index.
4. **Boundary PR: the new gift capital route.** Its registry entry alone, in
   `checkin-app/src/security/`, per the boundary isolation rule. Inert until
   step 5.
5. **Switch.** The gift page and queue take the capital decision; the drain
   registers and stamps; booking reads the gift line. The copy stops being
   written; the Donated Equipment page and nav entry go. Based on `main`, not on
   step 4's branch.
6. **Contract, decommission.** Drop `DonatedCapitalLine`,
   `CapitalAsset.sourceDonatedLineId`, `capitalSubmittedAt`, the two
   `donated-capital` routes and their registry entries, and the `submit`,
   `awaitingReview` and `assetLineIds` port methods. Shipped under the
   decommission exception in `docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
   rule 7, only after step 5 has been deployed to production.
7. **Extract the rules, delete both files.** The answered candidates in section
   6 of the design go into `docs/rules/expenses.md`.

## What each step must be safe against

- Step 2 against step 1's old code: an old release still deleting assets on
  clearing while the new one retires is harmless; the next-number read covers
  both (see the table).
- Step 5 against step 2's code: an old release still copying lines while the
  new one reads the gift line. The copy is ignored by the new reads and dropped
  in step 6.
- Step 6 only after no release that reads `DonatedCapitalLine` is serving.
