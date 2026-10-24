-- Finance's approval of an expense's tax, beside the expense; old code never reads it.
BEGIN;

CREATE TABLE "expense_tax_approvals" (
    "expense_id" TEXT NOT NULL,
    "tax_cents" INTEGER NOT NULL,
    "approved_by_user_id" INTEGER NOT NULL,
    "note" TEXT,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_tax_approvals_pkey" PRIMARY KEY ("expense_id")
);

ALTER TABLE "expense_tax_approvals" ADD CONSTRAINT "expense_tax_approvals_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
