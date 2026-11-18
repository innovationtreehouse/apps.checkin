BEGIN;

-- CreateEnum
CREATE TYPE "EnrollmentBasis" AS ENUM ('OUTSIDE_PAYMENT', 'MATCHED_ORDER', 'COMP');

-- AlterTable
ALTER TABLE "ProgramParticipant" ADD COLUMN "enrollmentBasis" "EnrollmentBasis";

COMMIT;
