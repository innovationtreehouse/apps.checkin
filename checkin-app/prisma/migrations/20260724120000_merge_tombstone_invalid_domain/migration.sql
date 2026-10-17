-- Data-only backfill (no schema change): merge tombstones held a sentinel email at
-- deleted.checkme.in — a REAL registrable domain (.in) the org does not control, so
-- mail to it could be received by whoever owns checkme.in. Rewrite to the RFC 2606 /
-- 6761 reserved .invalid TLD (guaranteed unregistrable, non-routable). id-keyed so the
-- Person.email @unique constraint still holds. Nothing matches this sentinel for logic
-- (tombstone detection is Person.mergedIntoId) — it's a pure placeholder.
UPDATE "Person"
SET email = 'merged-' || id || '@deleted.invalid'
WHERE email LIKE 'merged-%@deleted.checkme.in';
