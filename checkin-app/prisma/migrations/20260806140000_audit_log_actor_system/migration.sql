-- Names the automated path behind a system-actor audit row, and indexes the two
-- columns the audit-log viewer now filters on. Additive and nullable: rows
-- written by code still on the old revision leave it null, which reads as the
-- pre-existing "some system actor" and needs no backfill.
BEGIN;

ALTER TABLE "AuditLog" ADD COLUMN "actorSystem" TEXT;

CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE INDEX "AuditLog_actorSystem_idx" ON "AuditLog"("actorSystem");

COMMIT;
