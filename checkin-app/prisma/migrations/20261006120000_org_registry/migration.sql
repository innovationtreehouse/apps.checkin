-- Org registry, with the Treehouse row checkin-app's catalog configuration
-- expects. Idempotent insert so the seed and repeat runs do not conflict.
BEGIN;

CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Org" ("id", "name") VALUES ('treehouse', 'Treehouse') ON CONFLICT DO NOTHING;

COMMIT;
