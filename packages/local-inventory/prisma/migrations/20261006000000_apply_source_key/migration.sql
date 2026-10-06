-- Apply idempotency is keyed per source (`receipt:<id>` / `donation:<id>`), unique per org.
BEGIN;

DROP INDEX "received_inventory_deltas_receipt_id_key";

ALTER TABLE "received_inventory_deltas" ADD COLUMN "source_key" TEXT,
ADD COLUMN "result_json" TEXT,
ALTER COLUMN "receipt_id" DROP NOT NULL;

UPDATE "received_inventory_deltas" SET "source_key" = 'receipt:' || "receipt_id";

ALTER TABLE "received_inventory_deltas" ALTER COLUMN "source_key" SET NOT NULL;

CREATE UNIQUE INDEX "received_inventory_deltas_org_id_source_key_key" ON "received_inventory_deltas"("org_id", "source_key");

COMMIT;
