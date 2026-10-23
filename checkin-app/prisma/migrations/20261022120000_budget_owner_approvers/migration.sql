-- Bucket approvers stored on the bucket: an owner and a treasurer set, plus an
-- explicit org-level flag. Expand-only: the code that stops reading
-- BudgetOwner.programId and ProgramVolunteer.isTreasurer ships with this, and
-- those columns are dropped by a later migration. isOrgLevel is backfilled from
-- today's rule (no program = org-level); owners and treasurers start empty.
BEGIN;

-- AlterTable
ALTER TABLE "BudgetOwner" ADD COLUMN     "isOrgLevel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerId" INTEGER;

UPDATE "BudgetOwner" SET "isOrgLevel" = true WHERE "programId" IS NULL;

-- CreateTable
CREATE TABLE "BudgetOwnerTreasurer" (
    "budgetOwnerId" INTEGER NOT NULL,
    "personId" INTEGER NOT NULL,

    CONSTRAINT "BudgetOwnerTreasurer_pkey" PRIMARY KEY ("budgetOwnerId","personId")
);

-- CreateIndex
CREATE INDEX "BudgetOwner_ownerId_idx" ON "BudgetOwner"("ownerId");

-- CreateIndex
CREATE INDEX "BudgetOwnerTreasurer_personId_idx" ON "BudgetOwnerTreasurer"("personId");

-- AddForeignKey
ALTER TABLE "BudgetOwner" ADD CONSTRAINT "BudgetOwner_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetOwnerTreasurer" ADD CONSTRAINT "BudgetOwnerTreasurer_budgetOwnerId_fkey" FOREIGN KEY ("budgetOwnerId") REFERENCES "BudgetOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetOwnerTreasurer" ADD CONSTRAINT "BudgetOwnerTreasurer_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
