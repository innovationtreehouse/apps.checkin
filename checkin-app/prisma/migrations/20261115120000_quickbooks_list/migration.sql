-- The app's read-only copy of QuickBooks' account and Class lists, one row per list.
BEGIN;

CREATE TABLE "QuickBooksList" (
    "list" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksList_pkey" PRIMARY KEY ("list")
);

COMMIT;
