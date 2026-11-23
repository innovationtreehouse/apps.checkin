-- Drop the retired ops incident table and any Board-edited copies of its alert templates.
BEGIN;

DROP TABLE "OpsIncident";

DELETE FROM "EmailTemplate" WHERE key LIKE 'ops.incident%';

COMMIT;
