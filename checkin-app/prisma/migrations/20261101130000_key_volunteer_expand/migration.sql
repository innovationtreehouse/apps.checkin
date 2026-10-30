-- Key Volunteer expand stage (#1317): the role kind, the agreement process kind,
-- the version each agreement opened at, and the Board's current version.
-- Additive only; nothing writes these until the implementation release, so a
-- Prisma client that predates the enum values never reads one.
-- Postgres allows ADD VALUE inside a transaction; the values are not used here.
BEGIN;

ALTER TYPE "PersonRoleKind" ADD VALUE 'KEY_VOLUNTEER';
ALTER TYPE "OrgMembershipProcessKind" ADD VALUE 'KEY_VOLUNTEER_AGREEMENT';

ALTER TABLE "OrgMembershipProcess" ADD COLUMN "agreementVersion" INTEGER;
ALTER TABLE "BoardSettings" ADD COLUMN "keyVolunteerAgreementVersion" INTEGER NOT NULL DEFAULT 1;

COMMIT;
