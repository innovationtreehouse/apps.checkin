-- Finance may make a line's bucket final while settling an exception; no exception is raised on it after.
BEGIN;

ALTER TABLE "line_item_owner_approvals" ADD COLUMN "bucket_final" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
