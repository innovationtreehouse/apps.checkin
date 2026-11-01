-- Indexes for the expense reads that filter by org and state, or by expense: the candidate scan,
-- the approval and sign-off reads, and the audit rows read on every expense page.
BEGIN;

CREATE INDEX "expenses_org_id_state_submitted_at_idx" ON "expenses"("org_id", "state", "submitted_at" DESC);

CREATE INDEX "line_item_owner_approvals_expense_id_status_idx" ON "line_item_owner_approvals"("expense_id", "status");

CREATE INDEX "expense_line_signoffs_expense_id_idx" ON "expense_line_signoffs"("expense_id");

CREATE INDEX "expense_audit_log_expense_id_action_idx" ON "expense_audit_log"("expense_id", "action");

COMMIT;
