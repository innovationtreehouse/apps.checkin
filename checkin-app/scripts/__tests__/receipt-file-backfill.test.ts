/**
 * @jest-environment node
 */
const mockBackfillFiles = jest.fn(async () => ({ mismatches: [], failures: [] }));
const mockVerifyFiles = jest.fn();
const mockQueryRaw = jest.fn(async () => 1);
jest.mock("@checkin/receipt", () => ({
    backfillFiles: mockBackfillFiles,
    verifyFiles: mockVerifyFiles,
    getPrisma: () => ({ $queryRaw: mockQueryRaw }),
}));
jest.mock("../../src/lib/auroraResumeRetry", () => ({ retryP1001UntilDeadline: (run: () => unknown) => run() }));
jest.mock("../../src/lib/receipt/fileStore", () => ({ receiptFileStore: () => ({}) }));

async function runScript(env: { CHECKIN_ENV: string; bucket?: string }): Promise<{ code: unknown; errors: unknown[][] }> {
    process.env.CHECKIN_ENV = env.CHECKIN_ENV;
    if (env.bucket) process.env.RECEIPT_FILES_S3_BUCKET = env.bucket;
    else delete process.env.RECEIPT_FILES_S3_BUCKET;
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const code = await new Promise((resolve) => {
        jest.spyOn(process, "exit").mockImplementation(((exitCode?: number) => {
            resolve(exitCode);
            return undefined as never;
        }) as typeof process.exit);
        void jest.isolateModulesAsync(async () => {
            await import("../receipt-file-backfill");
        });
    });
    return { code, errors: errorSpy.mock.calls };
}

describe("receipt-file-backfill start check", () => {
    const saved = { env: process.env.CHECKIN_ENV, bucket: process.env.RECEIPT_FILES_S3_BUCKET };
    beforeEach(() => jest.clearAllMocks());
    afterEach(() => {
        jest.restoreAllMocks();
        process.env.CHECKIN_ENV = saved.env;
        if (saved.bucket) process.env.RECEIPT_FILES_S3_BUCKET = saved.bucket;
        else delete process.env.RECEIPT_FILES_S3_BUCKET;
    });

    it("exits non-zero with one error naming the variable, before touching the database, when a deployed instance has no bucket", async () => {
        const { code, errors } = await runScript({ CHECKIN_ENV: "dev" });
        expect(code).toBe(1);
        expect(errors).toHaveLength(1);
        expect(String(errors[0][0])).toContain("RECEIPT_FILES_S3_BUCKET");
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockBackfillFiles).not.toHaveBeenCalled();
    });

    it("stops a --verify run the same way", async () => {
        const savedArgv = process.argv;
        process.argv = [...savedArgv, "--verify"];
        try {
            const { code } = await runScript({ CHECKIN_ENV: "dev" });
            expect(code).toBe(1);
            expect(mockQueryRaw).not.toHaveBeenCalled();
            expect(mockVerifyFiles).not.toHaveBeenCalled();
        } finally {
            process.argv = savedArgv;
        }
    });

    it("runs when a deployed instance has a bucket", async () => {
        const { code } = await runScript({ CHECKIN_ENV: "dev", bucket: "bucket" });
        expect(code).toBe(0);
        expect(mockBackfillFiles).toHaveBeenCalledTimes(1);
    });

    it("runs on a laptop with no bucket, which stores files in a temp directory", async () => {
        const { code } = await runScript({ CHECKIN_ENV: "local" });
        expect(code).toBe(0);
        expect(mockBackfillFiles).toHaveBeenCalledTimes(1);
    });
});
