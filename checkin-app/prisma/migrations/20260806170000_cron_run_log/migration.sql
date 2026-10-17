-- Cron run ledger: one row per completed run of a /api/cron/* sweep, written by
-- withCron. Purely additive (new table, no FKs, nothing reads it yet), so it is
-- safe for old code serving traffic during the deploy drain window.
--
-- Two statements that must land together — the table is useless without the
-- index the staleness groupBy scans — so BEGIN/COMMIT (prisma migrate deploy
-- does not wrap a migration file in a transaction).
BEGIN;

CREATE TABLE "CronRunLog" (
    "id" SERIAL NOT NULL,
    "job" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,

    CONSTRAINT "CronRunLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CronRunLog_job_success_finishedAt_idx" ON "CronRunLog"("job", "success", "finishedAt");

COMMIT;
