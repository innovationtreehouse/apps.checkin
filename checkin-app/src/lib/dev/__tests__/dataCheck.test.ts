import { classifyPeople, runDevDataCheck, type DataCheckDb } from "@/lib/dev/dataCheck";

const SEEDED = "parent.family@example.com";
const ORG = "staff@innovationtreehouse.org";
const OTHER = "someone@other.invalid";

describe("classifyPeople", () => {
    it("flags people and households that are neither seeded nor org accounts", () => {
        const people = [
            { id: 1, email: SEEDED, householdId: 10 },
            { id: 2, email: null, householdId: 10 }, // emailless child in a seeded household
            { id: 3, email: ORG, householdId: 11 },
            { id: 4, email: OTHER, householdId: 12 },
            { id: 5, email: null, householdId: 12 }, // emailless child in an unseeded household
            { id: 7, email: "Mixed.Case@Example.COM", householdId: 13 },
            { id: 8, email: SEEDED.replace("parent", "other"), householdId: 14 },
            { id: 9, email: OTHER.replace("someone", "another"), householdId: 14 },
        ];
        const result = classifyPeople(people, [10, 11, 12, 13, 14, 15]);

        expect([...result.people].sort()).toEqual([4, 5, 9]);
        // 12 has an unseeded email; 14 mixes seeded and unseeded; 15 has nobody in it.
        expect([...result.households].sort()).toEqual([12, 14, 15]);
        expect(result.seededPeople).toBe(4);
        expect(result.orgAccounts).toBe(1);
    });
});

describe("runDevDataCheck", () => {
    const original = process.env.CHECKIN_ENV;
    afterEach(() => {
        process.env.CHECKIN_ENV = original;
    });

    function fakeDb() {
        const statements: string[] = [];
        const tx = {
            $executeRawUnsafe: jest.fn(async (sql: string) => {
                statements.push(sql);
                return 0;
            }),
            $queryRawUnsafe: jest.fn(async (sql: string) => {
                statements.push(sql);
                if (sql.includes('FROM "Person"') && sql.includes("email")) {
                    return [
                        { id: 1, email: SEEDED, householdId: 10 },
                        { id: 4, email: OTHER, householdId: 12 },
                    ];
                }
                if (sql.includes('FROM "Household"')) return [{ id: 10 }, { id: 12 }];
                if (sql.includes("pg_constraint")) {
                    return [
                        { tbl: '"ProgramParticipant"', col: "personId", ref: '"Person"' },
                        { tbl: '"ProgramParticipant"', col: "programId", ref: '"Program"' },
                    ];
                }
                if (sql.includes("count(*)")) return [{ n: 2 }];
                if (sql.includes("DISTINCT")) return [{ id: "7" }];
                return [];
            }),
        };
        const db: DataCheckDb = { $transaction: jest.fn(async (fn) => fn(tx)) };
        return { db, statements };
    }

    it.each(["prod", "stg", "", undefined])("refuses to run when CHECKIN_ENV is %p", async (env) => {
        if (env === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = env;
        const { db } = fakeDb();
        await expect(runDevDataCheck(db)).rejects.toThrow(/dev or local/);
        expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("reads inside a read-only transaction and reports counts with no personal data", async () => {
        process.env.CHECKIN_ENV = "dev";
        const { db, statements } = fakeDb();
        const report = await runDevDataCheck(db);

        expect(statements[0]).toBe("SET TRANSACTION READ ONLY");
        expect(statements.slice(1).every((s) => /^\s*SELECT/i.test(s))).toBe(true);
        expect(report.people).toEqual({ total: 2, seeded: 1, orgAccounts: 0, notSeeded: 1 });
        expect(report.households).toEqual({ total: 2, notSeeded: 1 });
        expect(report.linkedRows).toEqual([{ table: "ProgramParticipant", column: "personId", rows: 2 }]);
        expect(report.linkedRecords).toEqual({ Program: 1 });
        expect(JSON.stringify(report)).not.toMatch(/@|other\.invalid|example\.com/);
    });
});
