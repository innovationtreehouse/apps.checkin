-- QuickBooks matching moves to the expense (one entry per expense). An expense with exactly one
-- hand-matched line takes that line's entry; its qb_claim row already exists. An expense with
-- more than one waits for finance as AMBIGUOUS. Line columns are left as they are.
UPDATE "expenses" AS e
SET "qb_match_state" = 'MATCHED',
    "qb_txn_id" = li."qb_txn_id",
    "qb_txn_entity" = COALESCE(li."qb_txn_entity", CASE WHEN e."needs_reimbursement" THEN 'Bill' ELSE 'Purchase' END)
FROM "expense_line_items" AS li
WHERE li."expense_id" = e."id"
  AND li."qb_match_state" = 'MATCHED'
  AND li."qb_txn_id" IS NOT NULL
  AND e."qb_txn_id" IS NULL
  AND (SELECT COUNT(*) FROM "expense_line_items" AS m WHERE m."expense_id" = e."id" AND m."qb_match_state" = 'MATCHED') = 1;

UPDATE "expenses" AS e
SET "qb_match_state" = 'AMBIGUOUS'
WHERE e."qb_txn_id" IS NULL
  AND (SELECT COUNT(*) FROM "expense_line_items" AS m WHERE m."expense_id" = e."id" AND m."qb_match_state" = 'MATCHED') > 1;
