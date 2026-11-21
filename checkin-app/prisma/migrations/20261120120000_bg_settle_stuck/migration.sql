-- A background-check settle that failed after its event: first-failure time and latest error.
BEGIN;

ALTER TABLE "OrgMembershipProcess" ADD COLUMN "bgSettleFailedAt" TIMESTAMP(3),
ADD COLUMN "bgSettleError" TEXT;

COMMIT;
