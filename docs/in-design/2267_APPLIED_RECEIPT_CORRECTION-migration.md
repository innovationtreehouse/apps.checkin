# Cutover: correcting applied receipts

The one-time part of `2267_APPLIED_RECEIPT_CORRECTION.md`: where things stand
and the build order. Everything here stops being true once the last PR merges.
Its last step is "extract the rules, delete both files".

## Where it stands

- Designed; no question in design §9 is settled yet. Q1, Q2 and Q8 shape the
  contract and the expense intake, so PR 6 onward waits on them.
- Production holds no receipts, so nothing needs converting: no receipt has
  been corrected by hand that a correction would have to account for.
- Receipt lines lock once sent to apply (#2506, #2599). #2717 removed the cap on
  Board stand-ins; re-signing a corrected line relies on that.
- The issue body predates the line lock; the correction is commented on #2267.

## Build plan

Migrations first, each expand-only (new tables and nullable columns, nothing
dropped or renamed), so old code serving traffic during the deploy never sees a
column it doesn't know how to write. Then the security boundary, alone, as
`AGENTS.md` requires. Then the contract, then each library, then the
orchestrator that binds them, then the screens. Every app PR is test first, with
an integration test against real Postgres in its own library. PR numbers are
fixed IDs; a dropped PR leaves a gap.

| PR | Kind | What | Needs |
| --- | --- | --- | --- |
| 1 | mig | Workflow-mapping: `receipt_corrections` (receipt, seq, author, reason, state, leg stamps, claim lease, notes) and `receipt_correction_lines` (before and after per line); `received_receipts.replay_differs_at`. Models annotated `@sensitivity` | none |
| 2 | mig | Local-inventory: `inventory_log.correction_seq` (nullable) | none |
| 3 | mig | Expense: `received_expense_corrections` (receipt, seq, payload, status), mirroring `received_expense_payloads` | none |
| 4 | mig | Bulk-donation: `in_kind_donation_corrections` (receipt, seq, payload, status) and `in_kind_donations.correction_pending_at` | none |
| 5 | security boundary | Registry entries for `POST /api/workflow-mapping/receipts/[id]/corrections` and `.../corrections/[seq]/retry`; the receipt GET's `returns` widened to the correction models; synthetic classifications for them. Ships alone. If closing the new expense review or settling the gift correction needs a new route verb, its entry lands here too | PRs 1 to 4 merged |
| 6 | contract | `ReceiptCorrection` in `@checkin/receipt-types`, contract 1.4.0; the `applyCorrection` port in each sink's contract. No behaviour | Q1, Q2 |
| 7 | app | Local-inventory: apply a correction as source `correction:<receiptId>:<seq>`, signed deltas at the applied factor, receive-queue cancel and requeue, provisional-to-real follow, stock floor per Q10 | PR 6; Q10 |
| 8 | app | Expense: correction intake and catch-up replay; update lines and allocations; `clearFrom` per Q5; Everyday per Q7; the **Receipt corrected after booking** review per Q8 | PR 6; Q5, Q7, Q8 |
| 9 | app | Bulk-donation: correction intake; update lines, clear the decision per Q9; raise after booking per Q8 | PR 6; Q8, Q9 |
| 10 | app | Workflow-mapping: correction service and routes, the push-and-settle for corrections with lease and sweep, the line overlay for every reader, the differing-resend record per Q11; bind the three ports in `configure.ts` | PRs 5, 7, 8, 9; Q3, Q4, Q11, Q12 |
| 11 | app | Screens: **Correct** and **Corrections** on the receiving receipt page, the correction in expense history and the gift accept screen, the uploader's outcome line. A flow test for the whole journey: apply, correct a part, correct a quantity as finance, the expense goes back to approval, re-sign, stock checked | PR 10 |
| 12 | docs | Extract design §10 into `inventory.md`, `expenses.md` and `revenue.md`; add the correction step to `RECEIPT_PIPELINE.md`; delete both design files | PR 11 |

## Last step

PR 12 applies design §10 to the register and deletes this file and the design.
