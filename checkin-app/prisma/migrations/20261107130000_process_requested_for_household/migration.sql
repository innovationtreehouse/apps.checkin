BEGIN;

-- AlterTable
ALTER TABLE "OrgMembershipProcess" ADD COLUMN     "requestedForHouseholdId" INTEGER;

-- CreateIndex
CREATE INDEX "OrgMembershipProcess_requestedForHouseholdId_idx" ON "OrgMembershipProcess"("requestedForHouseholdId");

-- AddForeignKey
ALTER TABLE "OrgMembershipProcess" ADD CONSTRAINT "OrgMembershipProcess_requestedForHouseholdId_fkey" FOREIGN KEY ("requestedForHouseholdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
