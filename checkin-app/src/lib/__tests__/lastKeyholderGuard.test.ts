/**
 * Unit tests for the shared lastKeyholderGuard — the web-path equivalent
 * of the badge path's force-close flow in processCheckout.
 */
import type { DbClient } from "@/lib/db-client";
import { lastKeyholderGuard, FORCE_CLOSE_CONFIRM_SECONDS } from "@/lib/scan-service";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/attendanceTransitions", () => ({
    findAssociatedEventAt: jest.fn().mockResolvedValue(null),
    processVisitCheckout: jest.fn().mockResolvedValue([]),
}));

function fakeDb(opts: {
    remainingKeyholders?: number;
    remainingUsers?: Array<{ name: string | null; email: string | null }>;
    storedToken?: string | null;
}): DbClient {
    const { remainingKeyholders = 0, remainingUsers = [], storedToken = null } = opts;
    return {
        visit: {
            count: jest.fn().mockResolvedValue(remainingKeyholders),
            findMany: jest.fn().mockResolvedValue(
                remainingUsers.map((person, i) => ({ id: 100 + i, person }))
            ),
            findUnique: jest.fn().mockResolvedValue({ forceCloseToken: storedToken }),
            update: jest.fn().mockResolvedValue({}),
        },
    } as unknown as DbClient;
}

describe("lastKeyholderGuard", () => {
    it("proceeds without close when the person is not a keyholder", async () => {
        const result = await lastKeyholderGuard(1, { isKeyholder: false }, null, fakeDb({}));
        expect(result).toEqual({ action: "proceed", facilityClosed: false });
    });

    it("proceeds without close when other keyholders remain", async () => {
        const db = fakeDb({ remainingKeyholders: 2 });
        const result = await lastKeyholderGuard(1, { isKeyholder: true }, null, db);
        expect(result).toEqual({ action: "proceed", facilityClosed: false });
    });

    it("proceeds with facilityClosed when last keyholder and nobody else present", async () => {
        const db = fakeDb({ remainingKeyholders: 0, remainingUsers: [] });
        const result = await lastKeyholderGuard(42, { isKeyholder: true }, null, db);
        expect(result).toEqual({ action: "proceed", facilityClosed: true });
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: null, forceCloseToken: null },
        });
    });

    it("warns when last keyholder and others are present without a token", async () => {
        const db = fakeDb({
            remainingUsers: [{ name: "Alice", email: "alice@example.com" }],
        });
        const result = await lastKeyholderGuard(42, { isKeyholder: true }, null, db);

        expect(result.action).toBe("warn");
        if (result.action !== "warn") return;
        expect(result.token).toEqual(expect.any(String));
        expect(result.confirmSeconds).toBe(FORCE_CLOSE_CONFIRM_SECONDS);
        expect(result.message).toContain("Alice");
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: expect.any(Date), forceCloseToken: result.token },
        });
    });

    it("proceeds with facilityClosed when the echoed token matches", async () => {
        const db = fakeDb({
            remainingUsers: [{ name: "Bob", email: "bob@example.com" }],
            storedToken: "token-abc",
        });
        const result = await lastKeyholderGuard(42, { isKeyholder: true }, "token-abc", db);

        expect(result).toEqual({ action: "proceed", facilityClosed: true });
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: null, forceCloseToken: null },
        });
    });

    it("re-warns with a new token when the echoed token does not match", async () => {
        const db = fakeDb({
            remainingUsers: [{ name: "Carol", email: "carol@example.com" }],
            storedToken: "token-abc",
        });
        const result = await lastKeyholderGuard(42, { isKeyholder: true }, "wrong-token", db);

        expect(result.action).toBe("warn");
        if (result.action !== "warn") return;
        expect(result.token).not.toBe("token-abc");
    });

    it("uses email local-part when name is missing, never the full address", async () => {
        const db = fakeDb({
            remainingUsers: [{ name: null, email: "jane.doe@example.com" }],
        });
        const result = await lastKeyholderGuard(42, { isKeyholder: true }, null, db);

        expect(result.action).toBe("warn");
        if (result.action !== "warn") return;
        expect(result.names).toContain("jane.doe");
        expect(result.names).not.toContain("@");
    });

    it("names people by first name, never a last name", async () => {
        const db = fakeDb({
            remainingUsers: [{ name: "Riley Thompson", email: null }, { name: "Riley Tan", email: null }],
        });
        const result = await lastKeyholderGuard(42, { isKeyholder: true }, null, db);

        if (result.action !== "warn") throw new Error("expected warn");
        expect(result.names).toBe("Riley Th., Riley Ta.");
        expect(result.message).not.toMatch(/Thompson|Tan\b/);
    });
});
