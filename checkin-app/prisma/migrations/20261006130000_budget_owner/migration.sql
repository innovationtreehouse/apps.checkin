-- Budget-owner buckets (#1280 §6) + the program-treasurer flag. Additive,
-- expand-only: a brand-new table no code on origin/main reads, and a NOT NULL
-- column with a constant default (no table rewrite; old code never writes it,
-- so every row it inserts takes false). Seed rows arrive with the finance
-- screen, not here. Wrapped so both apply together or not at all.
BEGIN;

-- AlterTable
ALTER TABLE "ProgramVolunteer" ADD COLUMN     "isTreasurer" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BudgetOwner" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "programId" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "quickBooksClassId" TEXT,

    CONSTRAINT "BudgetOwner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BudgetOwner_quickBooksClassId_key" ON "BudgetOwner"("quickBooksClassId");

-- CreateIndex
CREATE INDEX "BudgetOwner_programId_idx" ON "BudgetOwner"("programId");

-- AddForeignKey
ALTER TABLE "BudgetOwner" ADD CONSTRAINT "BudgetOwner_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
