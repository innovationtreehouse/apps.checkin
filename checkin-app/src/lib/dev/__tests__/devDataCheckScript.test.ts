import { DevDataCheckRefused, runDevDataCheck } from "../dataCheck";

let mockReceipts: () => ReturnType<typeof receiptClient> = () => receiptClient("receipt_dev");
jest.mock("@checkin/receipt", () => ({ getPrisma: () => mockReceipts() }));
jest.mock("../dataCheck", () => ({ ...jest.requireActual("../dataCheck"), runDevDataCheck: jest.fn() }));

const report = {
    people: { total: 0, seeded: 0, orgAccounts: 0, notSeeded: 0 },
    households: { total: 0, notSeeded: 0 },
    linkedRows: [],
    linkedRecords: {},
};

function receiptClient(database: string) {
    return {
        $queryRawUnsafe: jest.fn(async () => [{ name: database }]),
        receipt: { count: jest.fn(async () => 3) },
    };
}

async function runScript() {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const exited = new Promise<number | undefined>((resolve) => {
        jest.spyOn(process, "exit").mockImplementation(((code?: number) => {
            resolve(code);
            return undefined as never;
        }) as typeof process.exit);
    });
    await jest.isolateModulesAsync(async () => {
        await import("../../../../scripts/dev-data-check");
    });
    return { code: await exited, errors: error.mock.calls, logs: log.mock.calls };
}

describe("dev-data-check script", () => {
    const original = { env: process.env.CHECKIN_ENV, url: process.env.RECEIPT_DATABASE_URL };
    beforeEach(() => {
        process.env.CHECKIN_ENV = "dev";
        process.env.RECEIPT_DATABASE_URL = "postgresql://u:p@db.internal.invalid:5432/receipt_dev";
    });
    afterEach(() => {
        process.env.CHECKIN_ENV = original.env;
        process.env.RECEIPT_DATABASE_URL = original.url;
        jest.restoreAllMocks();
    });

    it("prints a fixed failure message with no connection details", async () => {
        jest.mocked(runDevDataCheck).mockRejectedValue(new Error("connect ECONNREFUSED db.internal.invalid:5432"));
        const { code, errors } = await runScript();
        expect(code).toBe(1);
        expect(errors).toEqual([["dev-data-check failed"]]);
    });

    it("prints a fixed refusal message when the database is not dev's", async () => {
        jest.mocked(runDevDataCheck).mockRejectedValue(new DevDataCheckRefused("checkin_prod on db.internal.invalid"));
        const { code, errors } = await runScript();
        expect(code).toBe(1);
        expect(errors).toEqual([["dev-data-check refused: not the dev database"]]);
    });

    it("refuses a receipt database that is not dev's, without counting it", async () => {
        jest.mocked(runDevDataCheck).mockResolvedValue(report);
        const client = receiptClient("receipt_prod");
        mockReceipts = () => client;
        const { code, errors } = await runScript();
        expect(code).toBe(1);
        expect(errors).toEqual([["dev-data-check refused: not the dev database"]]);
        expect(client.receipt.count).not.toHaveBeenCalled();
    });

    it("counts receipts in dev's receipt database", async () => {
        jest.mocked(runDevDataCheck).mockResolvedValue(report);
        mockReceipts = () => receiptClient("receipt_dev");
        const { code, logs } = await runScript();
        expect(code).toBe(0);
        expect(JSON.parse(logs[0][0] as string).receiptsForInformation).toBe(3);
    });

    it("reports receipts unavailable when the receipt client cannot be built", async () => {
        jest.mocked(runDevDataCheck).mockResolvedValue(report);
        mockReceipts = () => {
            throw new Error("RECEIPT_DATABASE_URL is not set");
        };
        const { code, logs } = await runScript();
        expect(code).toBe(0);
        expect(JSON.parse(logs[0][0] as string).receiptsForInformation).toBe("unavailable");
    });
});
