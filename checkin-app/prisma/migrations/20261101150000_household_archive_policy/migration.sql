BEGIN;

ALTER TABLE "Household" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Household" FORCE ROW LEVEL SECURITY;

CREATE POLICY household_hide_archived ON "Household"
    FOR SELECT USING (
        "archivedAt" IS NULL
        OR current_setting('app.include_archived', true) = 'on'
    );

-- A FORCE'd table with RLS enabled denies any command lacking a permissive
-- policy. One per command: FOR ALL would also cover SELECT and undo the filter.
CREATE POLICY household_insert ON "Household"
    FOR INSERT WITH CHECK (true);
CREATE POLICY household_update ON "Household"
    FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY household_delete ON "Household"
    FOR DELETE USING (true);

COMMIT;
