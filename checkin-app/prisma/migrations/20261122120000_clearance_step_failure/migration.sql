-- A step owed after a clearance committed that failed, kept until it succeeds.
BEGIN;

CREATE TYPE "ClearanceStep" AS ENUM ('REFUNDED_ORDER_RAISE', 'PERSON_BG_TRIGGER', 'PERSON_AGREEMENT_TRIGGER');

CREATE TABLE "ClearanceStepFailure" (
    "id" SERIAL NOT NULL,
    "processId" INTEGER NOT NULL,
    "step" "ClearanceStep" NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT NOT NULL,

    CONSTRAINT "ClearanceStepFailure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClearanceStepFailure_processId_step_key" ON "ClearanceStepFailure"("processId", "step");

ALTER TABLE "ClearanceStepFailure" ADD CONSTRAINT "ClearanceStepFailure_processId_fkey" FOREIGN KEY ("processId") REFERENCES "OrgMembershipProcess"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
