-- Catalog events this library has applied; catch-up consumes any event in neither this nor failed_org_events.
CREATE TABLE "applied_org_events" (
    "id" INTEGER NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applied_org_events_pkey" PRIMARY KEY ("id")
);
