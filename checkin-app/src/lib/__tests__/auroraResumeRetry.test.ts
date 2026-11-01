import { withAuroraResumeRetry, retryP1001UntilDeadline } from "@/lib/auroraResumeRetry";

const p1001 = Object.assign(new Error("Can't reach database server"), { code: "P1001" });

describe("withAuroraResumeRetry", () => {
    it("retries on P1001 then succeeds", async () => {
        let calls = 0;
        const result = await withAuroraResumeRetry(async () => {
            calls++;
            if (calls < 3) throw p1001;
            return "ok";
        }, 5, 0);
        expect(result).toBe("ok");
        expect(calls).toBe(3);
    });

    it("rethrows non-P1001 errors immediately", async () => {
        let calls = 0;
        await expect(
            withAuroraResumeRetry(async () => {
                calls++;
                throw new Error("boom");
            }, 5, 0),
        ).rejects.toThrow("boom");
        expect(calls).toBe(1);
    });

    it("gives up after the attempt cap on persistent P1001", async () => {
        let calls = 0;
        await expect(
            withAuroraResumeRetry(async () => {
                calls++;
                throw p1001;
            }, 3, 0),
        ).rejects.toMatchObject({ code: "P1001" });
        expect(calls).toBe(3);
    });
});

describe("retryP1001UntilDeadline", () => {
    it("retries on P1001 until it succeeds within the deadline", async () => {
        let calls = 0;
        const result = await retryP1001UntilDeadline(async () => {
            calls++;
            if (calls < 3) throw p1001;
            return "ok";
        }, 5_000, 0);
        expect(result).toBe("ok");
        expect(calls).toBe(3);
    });

    it("rethrows non-P1001 errors immediately", async () => {
        let calls = 0;
        await expect(
            retryP1001UntilDeadline(async () => {
                calls++;
                throw new Error("boom");
            }, 5_000, 0),
        ).rejects.toThrow("boom");
        expect(calls).toBe(1);
    });

    it("gives up once the deadline has passed on persistent P1001", async () => {
        let calls = 0;
        await expect(
            retryP1001UntilDeadline(async () => {
                calls++;
                throw p1001;
            }, 0, 0), // deadline already reached after the first attempt
        ).rejects.toMatchObject({ code: "P1001" });
        expect(calls).toBe(1);
    });
});

describe("isDbResumeError — acquisition-phase signatures only", () => {
    const { isDbResumeError } = jest.requireActual("@/lib/auroraResumeRetry");
    it("matches P1001, P2024, and both pg connect-timeout messages", () => {
        expect(isDbResumeError({ code: "P1001" })).toBe(true);
        expect(isDbResumeError({ code: "P2024" })).toBe(true);
        // pg pool: no free connection within connectionTimeoutMillis
        expect(isDbResumeError(new Error("timeout exceeded when trying to connect"))).toBe(true);
        // pg client: socket still connecting when connectionTimeoutMillis fired.
        // Not retrying this logs users out after idle (JWT_SESSION_ERROR).
        expect(isDbResumeError(new Error("Connection terminated due to connection timeout"))).toBe(true);
    });
    it("rejects mid-query drops and unrelated errors (write-safety)", () => {
        // A LIVE connection dropped mid-statement — the query may have run, so never retry.
        // Must stay distinct from the "due to connection timeout" acquisition failure above.
        expect(isDbResumeError(new Error("Connection terminated unexpectedly"))).toBe(false);
        expect(isDbResumeError({ code: "P2002" })).toBe(false);
        expect(isDbResumeError(null)).toBe(false);
    });
});
