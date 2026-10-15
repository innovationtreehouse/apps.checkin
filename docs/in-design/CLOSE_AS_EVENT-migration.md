# Close as an event: cutover

The one-time steps for `CLOSE_AS_EVENT.md`. This file is deleted when the work
merges.

## Schema

There is one additive migration, `facility_close_execution`:

```sql
ALTER TABLE "FacilityClose" ADD COLUMN "clientEventId" TEXT;
ALTER TABLE "FacilityClose" ADD COLUMN "executedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "FacilityClose" SET "executedAt" = "createdAt";
CREATE UNIQUE INDEX "FacilityClose_clientEventId_key" ON "FacilityClose"("clientEventId");
CREATE INDEX "FacilityClose_executedAt_idx" ON "FacilityClose"("executedAt");
```

- **Why `executedAt` has a default.** During the rolling deploy, old code is still serving traffic and creates FacilityClose rows without knowing about the column. It also sweeps those rows itself. The default marks those rows executed, so new code never re-runs them. New code inserts `executedAt: null` explicitly when it records a close.
- **The backfill is one UPDATE on a small table.** Every existing row was executed when it was created.
- **Nothing is dropped or renamed.** The `Visit.forceClose*` columns stay, because the web dialog still uses them.

## Deploy order

1. Merge and deploy the server. It speaks protocol 6 and still accepts protocol 2–5 bodies, including the legacy close fields (design §3).
2. Cut the kiosk release tag straight after the server is live. The kiosk restarts within about 60 s, sees 6 advertised, and enables live sends.

There are two windows to understand:

- **New kiosk before the new server.** The kiosk queues every scan and holds its drain until 6 is advertised. The door still shows "will sync"; no scan is lost.
- **Old kiosk on the new server.** Between steps 1 and 2 nothing changes for the door:
  - A keyholder's checkout still decides the close from `shownEmpty`, else the server's records (design §3), and still offers the close.
  - The kiosk's offline confirms, token confirms and queued rows still close (legacy mapping).

## Rollback

- **Server rollback** to the previous image is safe. Old code ignores both columns. Its own closes get the default `executedAt`.
  - A close recorded by new code and not yet executed would stay unexecuted under old code. Before rolling back, run `SELECT id FROM "FacilityClose" WHERE "executedAt" IS NULL`. If anything comes back, let one scan or the cron re-drive it first.
- **Kiosk rollback** (re-tag the previous release) is safe. The old client ignores the new `close` outbox column. Rows queued with it lose the close on drain, so drain the outbox first.

## After the kiosk reports protocol 6

Once no outbox row can still carry the old fields (the kiosk's unsynced count
reads zero after the upgrade), remove these in a follow-up PR:
- the legacy mapping: `forceCloseConfirmed` and a kiosk `forceCloseToken`;
- `shownEmpty`;
- the `LegacyKiosk` branch of `processCheckout`.
