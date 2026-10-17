-- #1632: backfill staff walk-in visits (insert route's CREATE audit rows
-- tagged newData.type='staff_entry') from arrivedVia/departedVia=WEB to
-- LEAD_MARKED, matching the post-#1558 rule. Idempotent: only touches rows
-- still on WEB. Rationale/consequence: PR body.
UPDATE "Visit"
SET "arrivedVia" = CASE WHEN "arrivedVia" = 'WEB' THEN 'LEAD_MARKED' ELSE "arrivedVia" END::"VisitSource",
    "departedVia" = CASE WHEN "departedVia" = 'WEB' THEN 'LEAD_MARKED' ELSE "departedVia" END::"VisitSource"
WHERE "id" IN (
    SELECT "affectedEntityId"
    FROM "AuditLog"
    WHERE "tableName" = 'Visit'
      AND "action" = 'CREATE'
      AND "newData"->>'type' = 'staff_entry'
)
AND ("arrivedVia" = 'WEB' OR "departedVia" = 'WEB');
