-- Google Group list sync: per-person ledger, external contacts, list addresses. Additive; nothing reads it yet.
BEGIN;

-- CreateEnum
CREATE TYPE "ListTargetKind" AS ENUM ('MEMBERS', 'NEWSLETTER', 'PROGRAM_PARTICIPANTS', 'PROGRAM_PARENTS', 'PROGRAM_MENTORS', 'PROGRAM_EXTERNAL');

-- CreateEnum
CREATE TYPE "ListIntent" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "ListIntentSource" AS ENUM ('APP', 'EXTERNAL', 'BOARD', 'DEFAULT');

-- AlterTable
ALTER TABLE "BoardSettings" ADD COLUMN     "membersGoogleGroupEmail" TEXT,
ADD COLUMN     "newsletterGoogleGroupEmail" TEXT;

-- AlterTable
ALTER TABLE "Program" ADD COLUMN     "externalGoogleGroupEmail" TEXT,
ADD COLUMN     "mentorsGoogleGroupEmail" TEXT,
ADD COLUMN     "parentsGoogleGroupEmail" TEXT,
ADD COLUMN     "participantsGoogleGroupEmail" TEXT;

-- CreateTable
CREATE TABLE "ListSyncState" (
    "id" SERIAL NOT NULL,
    "personId" INTEGER NOT NULL,
    "targetKind" "ListTargetKind" NOT NULL,
    "targetRef" TEXT NOT NULL,
    "appliedEmail" TEXT,
    "appliedAt" TIMESTAMP(3),
    "reasons" TEXT[],
    "lastIntent" "ListIntent",
    "lastIntentAt" TIMESTAMP(3),
    "lastIntentSource" "ListIntentSource",
    "lastIntentActorId" INTEGER,
    "lastNoticeYear" INTEGER,
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramExternalContact" (
    "id" SERIAL NOT NULL,
    "programId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "appliedAt" TIMESTAMP(3),
    "lastIntent" "ListIntent",
    "lastIntentAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER,

    CONSTRAINT "ProgramExternalContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListSyncState_lastIntentActorId_idx" ON "ListSyncState"("lastIntentActorId");

-- CreateIndex
CREATE UNIQUE INDEX "ListSyncState_personId_targetKind_targetRef_key" ON "ListSyncState"("personId", "targetKind", "targetRef");

-- CreateIndex
CREATE INDEX "ProgramExternalContact_createdById_idx" ON "ProgramExternalContact"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramExternalContact_programId_email_key" ON "ProgramExternalContact"("programId", "email");

-- AddForeignKey
ALTER TABLE "ListSyncState" ADD CONSTRAINT "ListSyncState_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListSyncState" ADD CONSTRAINT "ListSyncState_lastIntentActorId_fkey" FOREIGN KEY ("lastIntentActorId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramExternalContact" ADD CONSTRAINT "ProgramExternalContact_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramExternalContact" ADD CONSTRAINT "ProgramExternalContact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
