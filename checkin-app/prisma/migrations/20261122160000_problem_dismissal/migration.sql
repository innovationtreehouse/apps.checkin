-- A stuck item dismissed from the Problems list, keyed by its failure time.
BEGIN;

CREATE TABLE "ProblemDismissal" (
    "id" SERIAL NOT NULL,
    "library" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL,
    "dismissedById" INTEGER NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProblemDismissal_library_step_itemId_failedAt_key" ON "ProblemDismissal"("library", "step", "itemId", "failedAt");

COMMIT;
