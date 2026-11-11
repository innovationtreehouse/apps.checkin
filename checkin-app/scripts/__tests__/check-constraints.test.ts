import { findMissingCheckConstraints, spliceCheckConstraints, type CheckConstraintRow } from "../lib/check-constraints";

const NAME_NOT_BLANK: CheckConstraintRow = {
    tablename: "Person",
    conname: "Person_name_not_blank",
    condef: "CHECK ((btrim(name) <> ''::text))",
};

const BASELINE = `-- CreateTable
CREATE TABLE "Household" (
    "id" SERIAL NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Person_name_idx" ON "Person"("name");
`;

describe("findMissingCheckConstraints", () => {
    it("returns constraints present in truth but absent from candidate", () => {
        expect(findMissingCheckConstraints([NAME_NOT_BLANK], [])).toEqual([NAME_NOT_BLANK]);
    });

    it("returns nothing when every constraint is present with the same definition", () => {
        expect(findMissingCheckConstraints([NAME_NOT_BLANK], [{ ...NAME_NOT_BLANK }])).toEqual([]);
    });

    it("treats a same-named constraint on another table as missing", () => {
        const elsewhere = { ...NAME_NOT_BLANK, tablename: "Household" };
        expect(findMissingCheckConstraints([NAME_NOT_BLANK], [elsewhere])).toEqual([NAME_NOT_BLANK]);
    });

    it("throws when the same-named constraint has a different definition", () => {
        const drifted = { ...NAME_NOT_BLANK, condef: "CHECK ((name <> ''::text))" };
        expect(() => findMissingCheckConstraints([NAME_NOT_BLANK], [drifted])).toThrow(/different definitions/);
    });
});

describe("spliceCheckConstraints", () => {
    it("is a no-op when nothing is missing", () => {
        expect(spliceCheckConstraints(BASELINE, [])).toBe(BASELINE);
    });

    it("inserts the constraint verbatim right after its table's CREATE TABLE", () => {
        const result = spliceCheckConstraints(BASELINE, [NAME_NOT_BLANK]);
        const stmt = `ALTER TABLE "Person" ADD CONSTRAINT "Person_name_not_blank" CHECK ((btrim(name) <> ''::text));`;
        expect(result).toContain(stmt);
        expect(result).toContain("coalesce-migrations: CHECK constraint restored");
        expect(result.indexOf('CREATE TABLE "Person"')).toBeLessThan(result.indexOf(stmt));
        expect(result.indexOf(stmt)).toBeLessThan(result.indexOf("-- CreateIndex"));
        expect(result.indexOf('CREATE TABLE "Household"')).toBeLessThan(result.indexOf('CREATE TABLE "Person"'));
    });

    it("places each constraint in its own table's section", () => {
        const householdCheck: CheckConstraintRow = { tablename: "Household", conname: "Household_id_positive", condef: "CHECK ((id > 0))" };
        const result = spliceCheckConstraints(BASELINE, [NAME_NOT_BLANK, householdCheck]);
        const householdStmt = result.indexOf('ADD CONSTRAINT "Household_id_positive"');
        expect(householdStmt).toBeGreaterThan(result.indexOf('CREATE TABLE "Household"'));
        expect(householdStmt).toBeLessThan(result.indexOf('CREATE TABLE "Person"'));
        expect(result.indexOf('ADD CONSTRAINT "Person_name_not_blank"')).toBeGreaterThan(result.indexOf('CREATE TABLE "Person"'));
    });

    it("throws when the constraint's table has no CREATE TABLE in the baseline", () => {
        const orphan = { ...NAME_NOT_BLANK, tablename: "OpsIncident", conname: "OpsIncident_openKey_check" };
        expect(() => spliceCheckConstraints(BASELINE, [orphan])).toThrow(/Cannot place CHECK constraint "OpsIncident_openKey_check"/);
    });
});
