-- The finance view log (Board ruling B11): one row per view of others' finance records.
-- Additive: a new table nothing reads or writes yet.
BEGIN;

-- CreateTable
CREATE TABLE "FinanceViewLog" (
    "id" SERIAL NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL,
    "actorId" INTEGER NOT NULL,
    "role" TEXT,
    "endpoint" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "recordIds" TEXT[],
    "rowCount" INTEGER NOT NULL,
    "window" TIMESTAMP(3) NOT NULL,
    "viewKey" TEXT NOT NULL,

    CONSTRAINT "FinanceViewLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinanceViewLog_viewedAt_idx" ON "FinanceViewLog"("viewedAt");

-- CreateIndex
CREATE INDEX "FinanceViewLog_actorId_viewedAt_idx" ON "FinanceViewLog"("actorId", "viewedAt");

-- CreateIndex
CREATE INDEX "FinanceViewLog_recordIds_idx" ON "FinanceViewLog" USING GIN ("recordIds");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceViewLog_actorId_viewKey_window_key" ON "FinanceViewLog"("actorId", "viewKey", "window");


COMMIT;
