BEGIN;

-- Nullable: requests already waiting have no stored year and resolve it at read time.
ALTER TABLE "OrgMembershipProcess" ADD COLUMN "paymentPlanYear" INTEGER;

COMMIT;
