BEGIN;

ALTER TABLE "OrgMembershipProcess" ADD COLUMN "archivedFromStatus" "OrgMembershipProcessStatus";

-- Backfill rows archived before the column existed, from the audit row that recorded
-- the transition — the one-time end of reading the log to find a restore target.
-- Legacy audit payloads are double-encoded JSON strings, hence the unwrap.
UPDATE "OrgMembershipProcess" p
SET "archivedFromStatus" = a.old_status::"OrgMembershipProcessStatus"
FROM (
    SELECT DISTINCT ON (l."affectedEntityId")
        l."affectedEntityId" AS process_id,
        (CASE WHEN jsonb_typeof(l."oldData") = 'string' AND (l."oldData" #>> '{}') LIKE '{%'
              THEN (l."oldData" #>> '{}')::jsonb ELSE l."oldData" END) ->> 'status' AS old_status
    FROM "AuditLog" l
    WHERE l."tableName" = 'OrgMembershipProcess'
      AND (CASE WHEN jsonb_typeof(l."newData") = 'string' AND (l."newData" #>> '{}') LIKE '{%'
                THEN (l."newData" #>> '{}')::jsonb ELSE l."newData" END) ->> 'status' = 'ARCHIVED'
    ORDER BY l."affectedEntityId", l.id DESC
) a
WHERE p.id = a.process_id
  AND p.status = 'ARCHIVED'
  AND a.old_status IN (
      'INTAKE', 'PENDING_EXTERNAL_ACTION', 'PENDING_BG_REVIEW', 'PENDING_PAYMENT',
      'PENDING_BG_CLEARANCE', 'PENDING_RENEWAL', 'RENEWAL_PENDING_BG', 'BLOCKED'
  );

COMMIT;
