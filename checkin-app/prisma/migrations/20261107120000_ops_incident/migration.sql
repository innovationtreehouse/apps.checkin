BEGIN;

-- AlterTable
ALTER TABLE "CronRunLog" ADD COLUMN     "failuresByKind" JSONB;

-- CreateTable
CREATE TABLE "OpsIncident" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "openKey" TEXT,
    "cause" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lanes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "lastRemindedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "recoveryNotifiedAt" TIMESTAMP(3),
    "runsSeen" INTEGER NOT NULL DEFAULT 1,
    "itemsAffected" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,

    CONSTRAINT "OpsIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpsIncident_openKey_key" ON "OpsIncident"("openKey");

-- CreateIndex
CREATE INDEX "OpsIncident_key_idx" ON "OpsIncident"("key");

-- CreateIndex
CREATE INDEX "OpsIncident_closedAt_idx" ON "OpsIncident"("closedAt");


-- An open incident carries its own key as openKey; a closed one carries none.
ALTER TABLE "OpsIncident" ADD CONSTRAINT "OpsIncident_openKey_check"
    CHECK (("openKey" IS NULL AND "closedAt" IS NOT NULL) OR ("openKey" = "key" AND "closedAt" IS NULL));

COMMIT;
