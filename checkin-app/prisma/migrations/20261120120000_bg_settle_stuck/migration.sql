-- AlterTable
ALTER TABLE "OrgMembershipProcess" ADD COLUMN "bgSettleFailedAt" TIMESTAMP(3),
ADD COLUMN "bgSettleError" TEXT;
