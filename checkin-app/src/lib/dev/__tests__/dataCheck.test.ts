import {
    classifyPeople,
    DevDataCheckRefused,
    isAllowedDatabase,
    runDevDataCheck,
    type DataCheckDb,
} from "@/lib/dev/dataCheck";

const SEEDED = "parent.family@example.com";
const ORG = "staff@innovationtreehouse.org";
const OTHER = "someone@other.invalid";
const LOCAL_URL = "postgresql://u:p@localhost:5432/checkmein";
const REMOTE_URL = "postgresql://u:p@db.remote.invalid:5432/checkmein";

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

    function fakeDb(database = "checkin_dev") {
        const statements: string[] = [];
        const tx = {
            $executeRawUnsafe: jest.fn(async (sql: string) => {
                statements.push(sql);
                return 0;
            }),
            $queryRawUnsafe: jest.fn(async (sql: string) => {
                statements.push(sql);
                if (sql.includes("current_database()")) return [{ name: database }];
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

    it.each([
        ["dev", "checkmein"],
        ["dev", "checkin_prod"],
        ["local", "checkin_prod"],
        ["local", "checkin_dev_copy"],
    ])("refuses to read when CHECKIN_ENV is %p and the database is %p", async (env, database) => {
        process.env.CHECKIN_ENV = env;
        const { db, statements } = fakeDb(database);
        await expect(runDevDataCheck(db, LOCAL_URL)).rejects.toThrow(DevDataCheckRefused);
        expect(statements.some((s) => s.includes('"Person"'))).toBe(false);
    });

    it.each([
        ["dev", "checkin_dev"],
        ["local", "checkmein"],
        ["local", "checkin_test_abc_1"],
    ])("runs when CHECKIN_ENV is %p and the database is %p", async (env, database) => {
        process.env.CHECKIN_ENV = env;
        const { db } = fakeDb(database);
        await expect(runDevDataCheck(db, LOCAL_URL)).resolves.toBeDefined();
    });

    it("refuses a local database named checkmein on a remote host", async () => {
        process.env.CHECKIN_ENV = "local";
        const { db, statements } = fakeDb("checkmein");
        await expect(runDevDataCheck(db, REMOTE_URL)).rejects.toThrow(DevDataCheckRefused);
        expect(statements.some((s) => s.includes('"Person"'))).toBe(false);
    });

    it("reads inside a read-only transaction and reports counts with no personal data", async () => {
        process.env.CHECKIN_ENV = "dev";
        const { db, statements } = fakeDb();
        const report = await runDevDataCheck(db, REMOTE_URL);

        expect(statements[0]).toBe("SET TRANSACTION READ ONLY");
        expect(statements.slice(1).every((s) => /^\s*SELECT/i.test(s))).toBe(true);
        expect(report.people).toEqual({ total: 2, seeded: 1, orgAccounts: 0, notSeeded: 1 });
        expect(report.households).toEqual({ total: 2, notSeeded: 1 });
        expect(report.linkedRows).toEqual([{ table: "ProgramParticipant", column: "personId", rows: 2 }]);
        expect(report.linkedRecords).toEqual({ Program: 1 });
        expect(JSON.stringify(report)).not.toMatch(/@|other\.invalid|example\.com/);
    });
});

describe("isAllowedDatabase", () => {
    it.each([
        ["postgresql://u:p@localhost:5432/x", true],
        ["postgresql://u:p@127.0.0.1:5432/x", true],
        ["postgresql://u:p@[::1]:5432/x", true],
        ["postgresql://u:p@db:5432/x", true],
        ["postgresql://u:p@db.remote.invalid:5432/x", false],
        ["not a url", false],
        [undefined, false],
    ])("under local, accepts checkmein at %p: %p", (url, allowed) => {
        expect(isAllowedDatabase("local", "checkmein", url)).toBe(allowed);
    });

    it("checks the receipt database by its own names", () => {
        expect(isAllowedDatabase("dev", "receipt_dev", REMOTE_URL, "receipt")).toBe(true);
        expect(isAllowedDatabase("dev", "receipt_prod", REMOTE_URL, "receipt")).toBe(false);
        expect(isAllowedDatabase("dev", "checkin_dev", REMOTE_URL, "receipt")).toBe(false);
        expect(isAllowedDatabase("local", "receipt", LOCAL_URL, "receipt")).toBe(true);
        expect(isAllowedDatabase("local", "receipt", REMOTE_URL, "receipt")).toBe(false);
    });
});
