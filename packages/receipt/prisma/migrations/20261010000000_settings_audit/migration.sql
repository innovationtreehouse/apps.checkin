-- Org-settings changes are audited in receipt_audit_log with no receipt.
ALTER TABLE "receipt_audit_log" ALTER COLUMN "receipt_id" DROP NOT NULL;
