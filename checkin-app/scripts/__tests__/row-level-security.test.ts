import { findMissingRls, renderPolicy, spliceRls, type PolicyRow, type RlsTableRow } from "../lib/row-level-security";

const HOUSEHOLD_RLS: RlsTableRow = { tablename: "Household", enabled: true, forced: true };
const HIDE_ARCHIVED: PolicyRow = {
    tablename: "Household",
    policyname: "household_hide_archived",
    permissive: "PERMISSIVE",
    roles: ["public"],
    cmd: "SELECT",
    qual: `(("archivedAt" IS NULL) OR (current_setting('app.include_archived'::text, true) = 'on'::text))`,
    withCheck: null,
};
const HOUSEHOLD_UPDATE: PolicyRow = {
    tablename: "Household",
    policyname: "household_update",
    permissive: "PERMISSIVE",
    roles: ["public"],
    cmd: "UPDATE",
    qual: "true",
    withCheck: "true",
};

const BASELINE = `-- CreateTable
CREATE TABLE "Household" (
    "id" SERIAL NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" SERIAL NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);
`;

const NONE = { tables: [], policies: [] };

describe("renderPolicy", () => {
    it("renders USING only when there is no WITH CHECK", () => {
        expect(renderPolicy(HIDE_ARCHIVED)).toBe(
            `CREATE POLICY "household_hide_archived" ON "Household" AS PERMISSIVE FOR SELECT TO PUBLIC USING (${HIDE_ARCHIVED.qual});`,
        );
    });

    it("renders both clauses and quotes named roles", () => {
        expect(renderPolicy({ ...HOUSEHOLD_UPDATE, roles: ["app_rw", "public"] })).toBe(
            `CREATE POLICY "household_update" ON "Household" AS PERMISSIVE FOR UPDATE TO "app_rw", PUBLIC USING (true) WITH CHECK (true);`,
        );
    });
});

describe("findMissingRls", () => {
    it("returns table flags and policies present in truth but absent from candidate", () => {
        const truth = { tables: [HOUSEHOLD_RLS], policies: [HIDE_ARCHIVED, HOUSEHOLD_UPDATE] };
        expect(findMissingRls(truth, NONE)).toEqual(truth);
    });

    it("returns nothing when candidate matches", () => {
        const truth = { tables: [HOUSEHOLD_RLS], policies: [HIDE_ARCHIVED] };
        expect(findMissingRls(truth, { tables: [{ ...HOUSEHOLD_RLS }], policies: [{ ...HIDE_ARCHIVED }] })).toEqual(NONE);
    });

    it("throws when a table's RLS flags differ", () => {
        const candidate = { tables: [{ ...HOUSEHOLD_RLS, forced: false }], policies: [] };
        expect(() => findMissingRls({ tables: [HOUSEHOLD_RLS], policies: [] }, candidate)).toThrow(/different definitions/);
    });

    it("throws when a same-named policy differs", () => {
        const candidate = { tables: [], policies: [{ ...HIDE_ARCHIVED, cmd: "ALL" as const }] };
        expect(() => findMissingRls({ tables: [], policies: [HIDE_ARCHIVED] }, candidate)).toThrow(/different definitions/);
    });
});

describe("spliceRls", () => {
    it("is a no-op when nothing is missing", () => {
        expect(spliceRls(BASELINE, NONE)).toBe(BASELINE);
    });

    it("puts ENABLE, FORCE, then policies right after the table's CREATE TABLE", () => {
        const result = spliceRls(BASELINE, { tables: [HOUSEHOLD_RLS], policies: [HIDE_ARCHIVED, HOUSEHOLD_UPDATE] });
        const at = (s: string) => result.indexOf(s);
        expect(result).toContain("coalesce-migrations: row-level security restored");
        expect(at('CREATE TABLE "Household"')).toBeLessThan(at('ALTER TABLE "Household" ENABLE ROW LEVEL SECURITY;'));
        expect(at("ENABLE ROW LEVEL SECURITY")).toBeLessThan(at('ALTER TABLE "Household" FORCE ROW LEVEL SECURITY;'));
        expect(at("FORCE ROW LEVEL SECURITY")).toBeLessThan(at(renderPolicy(HIDE_ARCHIVED)));
        expect(at(renderPolicy(HIDE_ARCHIVED))).toBeLessThan(at(renderPolicy(HOUSEHOLD_UPDATE)));
        expect(at(renderPolicy(HOUSEHOLD_UPDATE))).toBeLessThan(at('CREATE TABLE "Person"'));
    });

    it("throws when the table has no CREATE TABLE in the baseline", () => {
        expect(() => spliceRls(BASELINE, { tables: [{ ...HOUSEHOLD_RLS, tablename: "Gone" }], policies: [] })).toThrow(
            /Cannot place row-level security for "Gone"/,
        );
    });
});
