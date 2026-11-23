-- Drop BoardSettings.qboProductionRealmId: the field is unused and nothing reads or writes the column.
BEGIN;

-- AlterTable
ALTER TABLE "BoardSettings" DROP COLUMN "qboProductionRealmId";

COMMIT;
