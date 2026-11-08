-- Drop each account rule's fees account name: fees reduce income, so nothing reads it.
BEGIN;

ALTER TABLE "account_map" DROP COLUMN "fees_account";

COMMIT;
