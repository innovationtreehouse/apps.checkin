-- Records which of the two asks a scholarship / payment-plan request stands for.
-- Expand-only: new enum type plus a nullable column on each of the two request
-- models. Nullable with no default and no backfill on purpose — a request made
-- before this column has no truthful value, and inferring one would put words in
-- a family's mouth. Old code during the rolling-deploy drain window simply does
-- not write it, which reads back as the same "not stated".
--
-- Prisma does not wrap a migration file in a transaction on Postgres
-- (prisma/prisma#15295), so the three statements are wrapped by hand: a partial
-- apply would leave the type created and one of the two columns missing.
BEGIN;

CREATE TYPE "ScholarshipRequestKind" AS ENUM ('SCHOLARSHIP', 'PAYMENT_PLAN', 'UNSURE');

ALTER TABLE "OrgMembershipProcess" ADD COLUMN "scholarshipRequestKind" "ScholarshipRequestKind";

ALTER TABLE "ProgramParticipant" ADD COLUMN "scholarshipRequestKind" "ScholarshipRequestKind";

COMMIT;
