# Cutover: capital as a decision

The one-time part of `CAPITAL_AS_DECISION.md`: what happens to the records that
exist, the order of the PRs, and what each must be safe against. Everything here
stops being true once the last PR merges. Its last step is "extract the rules,
delete both files".

## Where it stands

- Designed, not built. Every owner question, CAD-1 to CAD-16, is settled.
  CAD-8's removal and the CAD-13 conventions are their own PRs, not steps here.
- **Production holds no capital records**: no assets on the register, no copied
  gift lines, no capital designations (@thpr). So there is nothing to carry
  over, no number to protect, and no backfill. Dev and local are reset from the
  seed instead.

## Existing records

| Environment | What happens |
|---|---|
| Production | Nothing to move. Step 1's migration counts `CapitalAsset` and `DonatedCapitalLine` rows and refuses to run if it finds any, so a capital record made since this was written is not silently left behind. |
| Dev and local | Reset from the seed after step 6 deploys. No script moves their rows. |

Each org's high-water mark starts at the highest number on its register, which
in production is none. Seeding historical numbers later raises it (CAD-12).

## Order

Old code keeps serving for the deploy drain, so a table is dropped only after
no release reads it. With no data to move, the steps are only about code.

1. **Schema.** Gift-line capital columns and the gift's `capitalReviewNeeded`
   in bulk-donation; `sourceKind`, gift source columns and `unitIndex` on
   `CapitalAsset`, with the unique index on (org, source, unit index);
   `CapitalAssetSequence`, set from the register. Refuses to run if production
   holds capital rows (above).
2. **Register and final expense capital.** Expense gains `register` and the
   high-water mark; both mint paths go through them. The capital steps do not
   open while the reimbursee is unknown, and the send-back edges out of them,
   with the asset deletion, go.
3. **The review module.** The two purchase steps' logic moves into the shared
   module behind the line store; the purchase routes bind it and behave as
   before. Expense only.
4. **Boundary PR: the two gift capital routes.** Their registry entries alone,
   in `checkin-app/src/security/`, per the boundary isolation rule. Inert until
   step 5.
5. **Switch.** The gift page takes the two capital steps; the threshold test
   runs at accept; the drain registers and stamps; a gift waits for its stamps
   before it books; booking reads the gift line. The copy stops being written;
   the Donated Equipment page and nav entry go. Based on `main`, not on step 4's
   branch.
6. **Contract, decommission.** Drop `DonatedCapitalLine`,
   `CapitalAsset.sourceDonatedLineId`, `capitalSubmittedAt`, the two
   `donated-capital` routes and their registry entries, and the `submit`,
   `awaitingReview` and `assetLineIds` port methods. Shipped under the
   decommission exception in `docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
   rule 7, only after step 5 has been deployed to production.
7. **Extract the rules, delete both files.** The settled rules in section 6 of
   the design go into `docs/rules/expenses.md`.

## What each step must be safe against

- Step 6 only after no release that reads `DonatedCapitalLine` is serving.
