-- Finance view log page views: page path, page-view id, calls, records with
-- their marked field names, and a record count; when an open page-view row
-- closes, and the page-view ids collapsed into a row. Additive for the running
-- code, which keeps writing endpoint, params and rowCount; rows that carry
-- calls leave those three null.
BEGIN;

-- AlterTable
ALTER TABLE "FinanceViewLog" ADD COLUMN     "calls" JSONB,
ADD COLUMN     "closesAt" TIMESTAMP(3),
ADD COLUMN     "mergedPageViewIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pagePath" TEXT,
ADD COLUMN     "pageViewId" TEXT,
ADD COLUMN     "recordCount" INTEGER,
ADD COLUMN     "records" JSONB,
ALTER COLUMN "endpoint" DROP NOT NULL,
ALTER COLUMN "params" DROP NOT NULL,
ALTER COLUMN "rowCount" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "FinanceViewLog_pageViewId_actorId_idx" ON "FinanceViewLog"("pageViewId", "actorId");

-- CreateIndex
CREATE INDEX "FinanceViewLog_actorId_closesAt_idx" ON "FinanceViewLog"("actorId", "closesAt");

-- CreateIndex
CREATE INDEX "FinanceViewLog_mergedPageViewIds_idx" ON "FinanceViewLog" USING GIN ("mergedPageViewIds");

COMMIT;
