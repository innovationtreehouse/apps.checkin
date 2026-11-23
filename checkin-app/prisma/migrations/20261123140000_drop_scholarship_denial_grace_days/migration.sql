-- Drop BoardSettings.scholarshipDenialGraceDays: the grace sweep that read it is
-- gone, and the Prisma client carries the column as @ignore, so nothing selects it.
BEGIN;

-- AlterTable
ALTER TABLE "BoardSettings" DROP COLUMN "scholarshipDenialGraceDays";

COMMIT;
