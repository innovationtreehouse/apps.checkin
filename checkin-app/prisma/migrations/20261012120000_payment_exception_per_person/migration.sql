-- Prisma does not wrap migrations in a transaction (prisma/prisma#15295) and
-- these statements must succeed together.
BEGIN;

DROP INDEX "PaymentException_kind_shopifyOrderId_key";

CREATE UNIQUE INDEX "PaymentException_kind_shopifyOrderId_personId_key"
    ON "PaymentException" ("kind", "shopifyOrderId", "personId");

COMMIT;
