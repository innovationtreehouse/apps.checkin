-- A gift's history reads its events by entity, oldest first. Additive: no code depends on it.
BEGIN;

CREATE INDEX "workflow_events_org_id_entity_type_entity_id_occurred_at_idx" ON "workflow_events"("org_id", "entity_type", "entity_id", "occurred_at");

COMMIT;
