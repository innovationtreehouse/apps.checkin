BEGIN;

-- CreateTable
CREATE TABLE "LifecycleDriftReport" (
    "id" SERIAL NOT NULL,
    "model" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "invariant" TEXT NOT NULL,
    "firstReportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleDriftReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleDriftReport_model_key_invariant_key" ON "LifecycleDriftReport"("model", "key", "invariant");

COMMIT;
