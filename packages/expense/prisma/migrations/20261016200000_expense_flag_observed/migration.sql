BEGIN;

-- AlterTable
ALTER TABLE "expense_flags" ADD COLUMN "observed" TEXT;

COMMIT;
