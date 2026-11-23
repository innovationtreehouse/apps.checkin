BEGIN;

ALTER TABLE "BoardSettings" DROP COLUMN "orgMembershipVariantId",
  DROP COLUMN "orgMembershipProductUrl";

COMMIT;
