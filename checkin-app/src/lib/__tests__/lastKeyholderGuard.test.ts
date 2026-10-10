/**
 * Unit tests for the shared lastKeyholderGuard: close, leave or cancel by
 * caller class on every web path (docs/rules/attendance-checkin.md).
 */
import type { DbClient } from "@/lib/db-client";
import { lastKeyholderGuard, FORCE_CLOSE_CONFIRM_SECONDS, type CloseActor } from "@/lib/scan-service";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/attendanceTransitions", () => ({
    findAssociatedEventAt: jest.fn().mockResolvedValue(null),
    processVisitCheckout: jest.fn().mockResolvedValue([]),
}));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));

const KEYHOLDER = { id: 7, isKeyholder: true };
const actor = (flags: Partial<CloseActor> = {}): CloseActor =>
    ({ id: 7, isKeyholder: false, isBoardMember: false, isSysadmin: false, ...flags });
const self = actor({ isKeyholder: true });
const board = actor({ id: 2, isBoardMember: true });
const sysadmin = actor({ id: 3, isSysadmin: true });
const lead = actor({ id: 4 });

function fakeDb(opts: {
    remainingKeyholders?: number;
    others?: Array<{ name: string | null; email: string | null }>;
    stored?: { forceCloseToken: string | null; forceCloseActorId: number | null };
    candidates?: Array<{ id: number; name: string }>;
    named?: { id: number } | null;
    consumed?: number;
}): DbClient {
    const { remainingKeyholders = 0, others = [], stored = { forceCloseToken: null, forceCloseActorId: null }, candidates = [], named = null, consumed = 1 } = opts;
    return {
        visit: {
            count: jest.fn().mockResolvedValueOnce(remainingKeyholders).mockResolvedValueOnce(others.length),
            findMany: jest.fn().mockResolvedValue(others.map((person, i) => ({ id: 100 + i, person }))),
            findUnique: jest.fn().mockResolvedValue(stored),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: consumed }),
        },
        person: {
            findMany: jest.fn().mockResolvedValue(candidates.map(c => ({ ...c, nickname: null, email: null }))),
            findFirst: jest.fn().mockResolvedValue(named),
        },
    } as unknown as DbClient;
}

const confirmedBy = (id: number) => ({ forceCloseToken: "tok", forceCloseActorId: id });
const proceed = (facilityClosed: boolean) => ({ action: "proceed", facilityClosed, choice: null });

describe("lastKeyholderGuard", () => {
    it("proceeds without close when the person is not a keyholder", async () => {
        expect(await lastKeyholderGuard(1, { id: 9, isKeyholder: false }, self, {}, {}, fakeDb({}))).toEqual(proceed(false));
    });

    it("proceeds without close when another keyholder remains", async () => {
        expect(await lastKeyholderGuard(1, KEYHOLDER, self, {}, {}, fakeDb({ remainingKeyholders: 1 }))).toEqual(proceed(false));
    });

    it("closes with no warning when the keyholder is alone and the caller may close", async () => {
        expect(await lastKeyholderGuard(42, KEYHOLDER, self, {}, {}, fakeDb({}))).toEqual(proceed(true));
        expect(await lastKeyholderGuard(42, KEYHOLDER, board, {}, {}, fakeDb({}))).toEqual(proceed(true));
    });

    it("never closes for a household lead or sysadmin, even with the keyholder alone", async () => {
        expect(await lastKeyholderGuard(42, KEYHOLDER, lead, {}, {}, fakeDb({}))).toEqual(proceed(false));
        expect(await lastKeyholderGuard(42, KEYHOLDER, sysadmin, {}, {}, fakeDb({}))).toEqual(proceed(false));
    });

    it("offers a keyholder close, leave or cancel with names, the pick-list, and says no other keyholder is in", async () => {
        const db = fakeDb({ others: [{ name: "Alice", email: null }], candidates: [{ id: 8, name: "Kim" }] });
        const result = await lastKeyholderGuard(42, KEYHOLDER, self, {}, {}, db);
        if (result.action !== "warn") throw new Error("expected warn");
        expect(result.warning).toMatchObject({
            type: "close_choice",
            othersInside: 1,
            choices: ["close", "leave", "cancel"],
            names: ["Alice"],
            keyholders: [{ id: 8, name: "Kim" }],
            confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS,
        });
        expect(result.warning.error).toContain("No other keyholder is checked in");
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: expect.any(Date), forceCloseToken: result.warning.forceCloseToken, forceCloseActorId: 7 },
        });
    });

    it("offers a household lead leave or cancel with a count, no names and no pick-list", async () => {
        const db = fakeDb({ others: [{ name: "Alice", email: null }, { name: "Bo", email: null }] });
        const result = await lastKeyholderGuard(42, KEYHOLDER, lead, {}, {}, db);
        if (result.action !== "warn") throw new Error("expected warn");
        expect(result.warning.choices).toEqual(["leave", "cancel"]);
        expect(result.warning.othersInside).toBe(2);
        expect(result.warning).not.toHaveProperty("names");
        expect(result.warning).not.toHaveProperty("keyholders");
        expect(result.warning.error).not.toMatch(/Alice|Bo\b/);
        expect(db.visit.findMany).not.toHaveBeenCalled();
    });

    it("offers a sysadmin leave or cancel, with names", async () => {
        const result = await lastKeyholderGuard(42, KEYHOLDER, sysadmin, {}, {}, fakeDb({ others: [{ name: "Alice", email: null }] }));
        if (result.action !== "warn") throw new Error("expected warn");
        expect(result.warning.choices).toEqual(["leave", "cancel"]);
        expect(result.warning.names).toEqual(["Alice"]);
    });

    it("offers a removal leave or cancel only, whoever removes", async () => {
        const result = await lastKeyholderGuard(42, KEYHOLDER, self, {}, { removal: true }, fakeDb({ others: [{ name: "Alice", email: null }] }));
        if (result.action !== "warn") throw new Error("expected warn");
        expect(result.warning.choices).toEqual(["leave", "cancel"]);
        expect(result.warning).not.toHaveProperty("keyholders");
    });

    it("closes on a matching token and the close choice", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(7) });
        const result = await lastKeyholderGuard(42, KEYHOLDER, self, { token: "tok", choice: "close" }, {}, db);
        expect(result).toEqual({ action: "proceed", facilityClosed: true, choice: { choice: "close", handoverToId: null, othersInside: 1 } });
        expect(db.visit.updateMany).toHaveBeenCalledWith({
            where: { id: 42, deletedAt: null, forceCloseToken: "tok", forceCloseActorId: 7 },
            data: { forceCloseWarnedAt: null, forceCloseToken: null, forceCloseActorId: null },
        });
    });

    it("refuses with 409, and does not re-bind, a token shown to another actor", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(99) });
        expect(await lastKeyholderGuard(42, KEYHOLDER, self, { token: "tok", choice: "close" }, {}, db))
            .toEqual({ action: "refuse", error: expect.any(String), status: 409 });
        expect(db.visit.update).not.toHaveBeenCalled();
    });

    it("refuses with 409 a token replayed after its confirm spent it", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }] });
        expect(await lastKeyholderGuard(42, KEYHOLDER, self, { token: "tok", choice: "close" }, {}, db))
            .toEqual({ action: "refuse", error: expect.any(String), status: 409 });
    });

    it("lets only one of two racing confirms consume the token", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(7), consumed: 0 });
        expect(await lastKeyholderGuard(42, KEYHOLDER, self, { token: "tok", choice: "close" }, {}, db))
            .toEqual({ action: "refuse", error: expect.any(String), status: 409 });
    });

    it("refuses a close when the keyholder role was revoked between warning and confirm", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(7) });
        const revoked = actor({ id: 7 });
        expect(await lastKeyholderGuard(42, KEYHOLDER, revoked, { token: "tok", choice: "close" }, {}, db))
            .toEqual({ action: "refuse", error: expect.any(String), status: 400 });
        expect(db.visit.updateMany).not.toHaveBeenCalled();
    });

    it("offers a keyholder checking out a different keyholder leave or cancel, with names and no pick-list", async () => {
        const other = actor({ id: 11, isKeyholder: true });
        const result = await lastKeyholderGuard(42, KEYHOLDER, other, {}, {}, fakeDb({ others: [{ name: "Bob", email: null }] }));
        if (result.action !== "warn") throw new Error("expected warn");
        expect(result.warning.choices).toEqual(["leave", "cancel"]);
        expect(result.warning.names).toEqual(["Bob"]);
        expect(result.warning).not.toHaveProperty("keyholders");
    });

    it("refuses a close confirm from a keyholder checking out a different keyholder", async () => {
        const other = actor({ id: 11, isKeyholder: true });
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(11) });
        expect(await lastKeyholderGuard(42, KEYHOLDER, other, { token: "tok", choice: "close" }, {}, db))
            .toEqual({ action: "refuse", error: expect.any(String), status: 400 });
        expect(db.visit.updateMany).not.toHaveBeenCalled();
    });

    it("never closes for a different keyholder, even with the keyholder alone", async () => {
        expect(await lastKeyholderGuard(42, KEYHOLDER, actor({ id: 11, isKeyholder: true }), {}, {}, fakeDb({}))).toEqual(proceed(false));
    });

    it("refuses a close from a caller who may only leave", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(4) });
        expect(await lastKeyholderGuard(42, KEYHOLDER, lead, { token: "tok", choice: "close" }, {}, db))
            .toEqual({ action: "refuse", error: expect.any(String), status: 400 });
    });

    it("lets a household lead leave without naming anyone", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(4) });
        expect(await lastKeyholderGuard(42, KEYHOLDER, lead, { token: "tok", choice: "leave" }, {}, db))
            .toEqual({ action: "proceed", facilityClosed: false, choice: { choice: "leave", handoverToId: null, othersInside: 1 } });
    });

    it("records the keyholder a keyholder's leave names", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(7), candidates: [{ id: 8, name: "Kim" }], named: { id: 8 } });
        expect(await lastKeyholderGuard(42, KEYHOLDER, self, { token: "tok", choice: "leave", handoverToId: 8 }, {}, db))
            .toEqual({ action: "proceed", facilityClosed: false, choice: { choice: "leave", handoverToId: 8, othersInside: 1 } });
    });

    it("refuses a keyholder's leave that names nobody while a keyholder is free to name", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(7), candidates: [{ id: 8, name: "Kim" }] });
        expect((await lastKeyholderGuard(42, KEYHOLDER, self, { token: "tok", choice: "leave" }, {}, db)).action).toBe("refuse");
    });

    it("accepts a keyholder's unnamed leave when no keyholder is free to name", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(7) });
        expect(await lastKeyholderGuard(42, KEYHOLDER, self, { token: "tok", choice: "leave" }, {}, db))
            .toEqual({ action: "proceed", facilityClosed: false, choice: { choice: "leave", handoverToId: null, othersInside: 1 } });
    });

    it("refuses a leave naming someone who is not a keyholder", async () => {
        const db = fakeDb({ others: [{ name: "Bob", email: null }], stored: confirmedBy(7), candidates: [{ id: 8, name: "Kim" }], named: null });
        expect((await lastKeyholderGuard(42, KEYHOLDER, self, { token: "tok", choice: "leave", handoverToId: 55 }, {}, db)).action).toBe("refuse");
    });

    it("uses the email local-part when name is missing, never the address", async () => {
        const result = await lastKeyholderGuard(42, KEYHOLDER, self, {}, {}, fakeDb({ others: [{ name: null, email: "jane.doe@example.com" }] }));
        if (result.action !== "warn") throw new Error("expected warn");
        expect(result.warning.names).toEqual(["jane.doe"]);
    });

    it("names people by first name, never a last name", async () => {
        const result = await lastKeyholderGuard(42, KEYHOLDER, self, {}, {}, fakeDb({ others: [{ name: "Riley Thompson", email: null }, { name: "Riley Tan", email: null }] }));
        if (result.action !== "warn") throw new Error("expected warn");
        expect(result.warning.names).toEqual(["Riley Th.", "Riley Ta."]);
    });
});
