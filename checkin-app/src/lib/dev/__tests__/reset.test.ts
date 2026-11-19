import { DevResetRefused, resetTargets, truncateDevDatabases, type ResetTarget } from "@/lib/dev/reset";

const REMOTE = (db: string) => `postgresql://u:p@db.remote.invalid:5432/${db}`;

function fakeDb(name: string, tables: string[], log: string[]) {
    return {
        $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
            if (query.includes("current_database")) return [{ name }];
            if (!query.includes("pg_tables")) throw new Error(`unexpected query: ${query}`);
            const keep = values[0] as string[];
            return tables.filter((t) => !keep.includes(t)).map((tablename) => ({ tablename }));
        },
        $executeRawUnsafe: async (query: string) => {
            log.push(`${name}: ${query}`);
            return 0;
        },
        end: async () => {
            log.push(`${name}: end`);
        },
    };
}

describe("truncateDevDatabases", () => {
    const original = { env: process.env.CHECKIN_ENV, url: process.env.DATABASE_URL };
    beforeEach(() => {
        process.env.CHECKIN_ENV = "dev";
        process.env.DATABASE_URL = REMOTE("checkin_dev");
    });
    afterEach(() => {
        process.env.CHECKIN_ENV = original.env;
        process.env.DATABASE_URL = original.url;
    });

    const targets: ResetTarget[] = [
        { db: "expense", url: REMOTE("expense_dev") },
        { db: "income", url: null },
        { db: "shopify_read", url: REMOTE("shopify_read_dev") },
    ];

    function run(names: Record<string, string>, log: string[]) {
        const checkin = fakeDb(names.checkin ?? "checkin_dev", ["Person", "DevLedger", "_prisma_migrations"], log);
        const reseed = jest.fn(async () => log.push("reseed"));
        const connect = async (url: string) => {
            const db = url.split("/").pop()!;
            return fakeDb(names[db] ?? db, ["rows", "_prisma_migrations"], log);
        };
        return { reseed, done: truncateDevDatabases(checkin, reseed, targets, connect) };
    }

    it("truncates checkin, then each configured library, then Shopify-read, keeping migrations and the ledger", async () => {
        const log: string[] = [];
        const { done } = run({}, log);

        await expect(done).resolves.toEqual({ skipped: ["income"] });
        expect(log).toEqual([
            'checkin_dev: TRUNCATE TABLE "Person" CASCADE',
            'expense_dev: TRUNCATE TABLE "rows" CASCADE',
            'shopify_read_dev: TRUNCATE TABLE "rows" CASCADE',
            "reseed",
            "expense_dev: end",
            "shopify_read_dev: end",
        ]);
    });

    it("refuses before truncating anything when one connection names a database outside dev", async () => {
        const log: string[] = [];
        const { done, reseed } = run({ shopify_read_dev: "shopify_read_prod" }, log);

        await expect(done).rejects.toThrow(DevResetRefused);
        expect(log.filter((l) => l.includes("TRUNCATE"))).toEqual([]);
        expect(reseed).not.toHaveBeenCalled();
    });

    it("refuses when checkin is not the dev database", async () => {
        const log: string[] = [];
        const { done } = run({ checkin: "checkin_prod" }, log);

        await expect(done).rejects.toThrow(DevResetRefused);
        expect(log.filter((l) => l.includes("TRUNCATE"))).toEqual([]);
    });

    it("reseeds checkin even when a library truncate fails", async () => {
        const log: string[] = [];
        const checkin = fakeDb("checkin_dev", ["Person"], log);
        const reseed = jest.fn(async () => undefined);
        const failing = async () => ({
            ...fakeDb("expense_dev", ["rows"], log),
            $executeRawUnsafe: async () => {
                throw new Error("permission denied");
            },
        });

        await expect(truncateDevDatabases(checkin, reseed, [targets[0]], failing)).rejects.toThrow("permission denied");
        expect(reseed).toHaveBeenCalled();
    });

    it("refuses outside dev and local", async () => {
        process.env.CHECKIN_ENV = "prod";
        const log: string[] = [];
        await expect(run({}, log).done).rejects.toThrow(DevResetRefused);
        expect(log).toEqual([]);
    });
});

describe("resetTargets", () => {
    it("lists every library database, then Shopify-read", () => {
        expect(resetTargets().map((t) => t.db)).toEqual([
            "catalog",
            "local_inventory",
            "bulk_donation",
            "expense",
            "workflow_mapping",
            "income",
            "receipt",
            "shopify_read",
        ]);
    });
});
