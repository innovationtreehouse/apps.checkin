/*
  FR7 (issue #354) — Release 2: drop the dead `Fee` / `FeePayment` tables.

  These tables have no production writer (only the old dev seed ever wrote them);
  payment truth lives in the Shopify pipeline (ProgramParticipant.status +
  shopifyOrderId, shopify_read, PaymentException). See
  docs/designs/354_KILL_FEE_FEEPAYMENT.md.

  ORDER OF OPERATIONS (deploy gate): Release 1 (#1404, dropped every app/test
  read of these tables) must be fully deployed EVERYWHERE before this DROP runs.
  Migrations complete before the rolling deploy starts, so old pods still running
  `include: { fees: true }` would 500 for the drain window if this landed first.
  Prod row counts must be 0 (no writer exists) — data-safe.

  Wrapped in BEGIN/COMMIT: Prisma does not wrap migration files in a transaction
  on Postgres, so this multi-statement drop stays atomic (all-or-nothing retry).
*/
BEGIN;

-- DropForeignKey
ALTER TABLE "Fee" DROP CONSTRAINT "Fee_programId_fkey";

-- DropForeignKey
ALTER TABLE "FeePayment" DROP CONSTRAINT "FeePayment_feeId_fkey";

-- DropForeignKey
ALTER TABLE "FeePayment" DROP CONSTRAINT "FeePayment_personId_fkey";

-- DropTable
DROP TABLE "Fee";

-- DropTable
DROP TABLE "FeePayment";

COMMIT;
