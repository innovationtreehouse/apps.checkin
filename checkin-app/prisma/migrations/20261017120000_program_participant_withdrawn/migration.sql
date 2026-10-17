BEGIN;

-- Expand only: nothing writes WITHDRAWN or endedAt until a later release.
ALTER TYPE "ProgramParticipantStatus" ADD VALUE 'WITHDRAWN';

ALTER TABLE "ProgramParticipant" ADD COLUMN "endedAt" TIMESTAMP(3);

COMMIT;
