-- Prisma does not wrap migrations in a transaction (prisma/prisma#15295) and
-- these statements must succeed together.
BEGIN;

DROP INDEX "PaymentException_kind_shopifyOrderId_key";

-- Partial indexes, not expressible in schema.prisma: keep (kind, order) dedup for
-- rows with no person (membership) while giving each person on a program order its
-- own row. Rows with no order stay distinct (NULL shopifyOrderId).
CREATE UNIQUE INDEX "PaymentException_kind_order_no_person_key"
    ON "PaymentException" ("kind", "shopifyOrderId") WHERE "personId" IS NULL;

CREATE UNIQUE INDEX "PaymentException_kind_order_person_key"
    ON "PaymentException" ("kind", "shopifyOrderId", "personId") WHERE "personId" IS NOT NULL;

COMMIT;
