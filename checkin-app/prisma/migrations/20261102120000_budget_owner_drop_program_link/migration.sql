-- Contract step for 20261022120000_budget_owner_approvers: a bucket's approvers
-- live on the bucket, so its program link and the program treasurer flag go.
-- Only safe once the code that stopped reading both is fully rolled out.
BEGIN;

-- DropForeignKey
ALTER TABLE "BudgetOwner" DROP CONSTRAINT "BudgetOwner_programId_fkey";

-- DropIndex
DROP INDEX "BudgetOwner_programId_idx";

-- AlterTable
ALTER TABLE "BudgetOwner" DROP COLUMN "programId";

-- AlterTable
ALTER TABLE "ProgramVolunteer" DROP COLUMN "isTreasurer";

COMMIT;
