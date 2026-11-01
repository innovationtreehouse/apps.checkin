BEGIN;

ALTER TABLE "OrgMembershipProcess" ADD COLUMN "zohoClaimedAt" TIMESTAMP(3);

-- Claims already stranded get a timestamp, so the normal window frees them.
UPDATE "OrgMembershipProcess"
SET "zohoClaimedAt" = CURRENT_TIMESTAMP
WHERE "zohoSignerPersonId" IS NOT NULL
  AND "contractSignedAt" IS NULL
  AND ("zohoEnvelopeId" IS NULL OR "zohoActionId" IS NULL);

COMMIT;
