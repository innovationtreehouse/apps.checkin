-- Stage-2 substrate (KIOSK_RESILIENCE §6): append-only intent log. Expand-only
-- — no writer on origin/main touches this table, so old tasks keep serving
-- against the migrated schema. Direction is what the producing surface
-- displayed; Visits project from the ordered log in a follow-on cutover in
-- the same PR (gated on the request carrying `intent`).
--
-- Wrapped: Prisma does not wrap a migration file in a transaction on Postgres.
BEGIN;

CREATE TYPE "PresenceDirection" AS ENUM ('IN', 'OUT');

CREATE TABLE "PresenceEvent" (
    "id" SERIAL NOT NULL,
    "personId" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "direction" "PresenceDirection" NOT NULL,
    "source" "VisitSource" NOT NULL,
    "clientEventId" TEXT,
    "classification" TEXT,
    "clockSuspect" BOOLEAN NOT NULL DEFAULT false,
    "visitId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PresenceEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PresenceEvent_clientEventId_key" ON "PresenceEvent"("clientEventId");
CREATE INDEX "PresenceEvent_personId_occurredAt_idx" ON "PresenceEvent"("personId", "occurredAt");
CREATE INDEX "PresenceEvent_classification_occurredAt_idx" ON "PresenceEvent"("classification", "occurredAt");

ALTER TABLE "PresenceEvent" ADD CONSTRAINT "PresenceEvent_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
