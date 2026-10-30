-- Grandfathers the current holders of the four roles a Key Volunteer
-- Agreement now gates (BOARD, BG_REVIEWER, KEYHOLDER, FINANCE): each live
-- person holding one gets KEY_VOLUNTEER and an agreement already signed at
-- version 1, dated now, recorded as by the Board with no Zoho request.
-- Rests on @thpr's statement of 2026-10-30 that they are known to have signed
-- (docs/rules/membership.md, "Key Volunteers").
--
-- Data only and idempotent: anyone already holding KEY_VOLUNTEER is skipped.
-- Opens no unsigned agreement, so it creates no Zoho request. One statement:
-- every CTE reads the same snapshot, so the candidate set is fixed once.
BEGIN;

-- keyVolunteerGrandfather.integration.test.ts runs the statement between these markers.
-- >>> GRANDFATHER START
WITH candidates AS (
  SELECT DISTINCT r."personId"
  FROM "PersonRole" r
  JOIN "Person" p ON p.id = r."personId"
  WHERE r."role" IN ('BOARD', 'BG_REVIEWER', 'KEYHOLDER', 'FINANCE')
    AND p."mergedIntoId" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "PersonRole" k WHERE k."personId" = r."personId" AND k."role" = 'KEY_VOLUNTEER'
    )
),
granted AS (
  INSERT INTO "PersonRole" ("personId", "role")
  SELECT "personId", 'KEY_VOLUNTEER' FROM candidates
  RETURNING "personId"
),
role_audit AS (
  INSERT INTO "AuditLog" ("actorId", "actorSystem", "action", "tableName", "affectedEntityId", "oldData", "newData")
  SELECT 0, 'migration:key-volunteer-grandfather', 'EDIT', 'PersonRole', "personId",
         '{"isKeyVolunteer": false}'::jsonb, '{"isKeyVolunteer": true}'::jsonb
  FROM granted
),
signed AS (
  INSERT INTO "OrgMembershipProcess"
    ("subjectPersonId", "orgMembershipId", "kind", "status", "agreementVersion", "contractSignedAt", "stageEnteredAt")
  SELECT "personId", NULL, 'KEY_VOLUNTEER_AGREEMENT', 'ACTIVE', 1, now(), now() FROM granted
  RETURNING id, "subjectPersonId"
)
INSERT INTO "AuditLog" ("actorId", "actorSystem", "action", "tableName", "affectedEntityId", "newData")
SELECT 0, 'migration:key-volunteer-grandfather', 'CREATE', 'OrgMembershipProcess', id,
       jsonb_build_object(
         'kind', 'KEY_VOLUNTEER_AGREEMENT', 'status', 'ACTIVE', 'agreementVersion', 1,
         'subjectPersonId', "subjectPersonId", 'contractSignedAt', true
       )
FROM signed;
-- <<< GRANDFATHER END

COMMIT;
