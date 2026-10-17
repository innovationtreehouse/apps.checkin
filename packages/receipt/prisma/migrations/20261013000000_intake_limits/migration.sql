-- Indexes for the daily intake limits' windowed counts.
CREATE INDEX "receipts_org_id_uploaded_at_idx" ON "receipts"("org_id", "uploaded_at");
CREATE INDEX "receipt_audit_log_user_id_action_changed_at_idx" ON "receipt_audit_log"("user_id", "action", "changed_at");
