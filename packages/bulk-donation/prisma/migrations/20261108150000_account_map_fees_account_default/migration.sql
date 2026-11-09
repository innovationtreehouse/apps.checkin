-- Nothing writes an account rule's fees account name any more; new rules take an empty one.
BEGIN;

ALTER TABLE "account_map" ALTER COLUMN "fees_account" SET DEFAULT '';

COMMIT;
