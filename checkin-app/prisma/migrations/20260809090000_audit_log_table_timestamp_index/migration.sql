-- Serves the attendance-corrections review: AuditLog filtered to one tableName
-- over a timestamp range, ordered by timestamp DESC. Additive and non-blocking
-- for readers; CREATE INDEX takes a brief write lock on AuditLog.
CREATE INDEX "AuditLog_tableName_timestamp_idx" ON "AuditLog"("tableName", "timestamp");
