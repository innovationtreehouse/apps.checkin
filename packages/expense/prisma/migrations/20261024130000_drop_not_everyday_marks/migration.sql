-- Drop FINANCE's retired "not Everyday" marks. Nothing selects them: the Prisma
-- client has carried both as @ignore since the release that made the amounts
-- alone decide Everyday. Their values are discarded on purpose, so no guard.
BEGIN;

ALTER TABLE "expenses" DROP COLUMN "single_source",
DROP COLUMN "finance_not_everyday";

COMMIT;
