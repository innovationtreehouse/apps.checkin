-- Drop the four legacy two-variant Shopify columns (#975). Nothing selects them:
-- the Prisma client has carried them as @ignore since Release 2a.
-- Fails closed if a row still depends on them, so the drop never destroys the
-- only record of a program's or the membership's Shopify variant.
BEGIN;

DO $$
DECLARE
    stranded_programs integer;
    board_legacy integer;
BEGIN
    SELECT count(*) INTO stranded_programs FROM "Program"
    WHERE "shopifyVariantId" IS NULL
      AND ("shopifyOrgMemberVariantId" IS NOT NULL OR "shopifyNonOrgMemberVariantId" IS NOT NULL);

    SELECT count(*) INTO board_legacy FROM "BoardSettings"
    WHERE id = 1
      AND ("shopifyNormalVariantId" IS NOT NULL OR "shopifyVolunteerVariantId" IS NOT NULL);

    IF stranded_programs > 0 OR board_legacy > 0 THEN
        RAISE EXCEPTION 'Refusing to drop legacy variant columns: % program row(s) have a legacy variant and no shopifyVariantId; BoardSettings legacy variant set: %',
            stranded_programs, board_legacy > 0;
    END IF;
END $$;

ALTER TABLE "Program" DROP COLUMN "shopifyOrgMemberVariantId";
ALTER TABLE "Program" DROP COLUMN "shopifyNonOrgMemberVariantId";
ALTER TABLE "BoardSettings" DROP COLUMN "shopifyNormalVariantId";
ALTER TABLE "BoardSettings" DROP COLUMN "shopifyVolunteerVariantId";

COMMIT;
