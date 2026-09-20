/**
 * The scan response feeds the kiosk banner on an unattended public screen, which
 * forwards it into an iframe with a wildcard postMessage origin (client/client.py).
 * So `participant` is a display DTO — id plus the nickname-else-first-name label —
 * and never the raw Person (docs/rules/attendance-checkin.md, "The kiosk").
 */
import type { Person } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { processCheckin, processCheckout } from "@/lib/scan-service";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/attendanceTransitions", () => ({
    findAssociatedEventAt: jest.fn().mockResolvedValue(null),
    processVisitCheckout: jest.fn().mockResolvedValue([{ id: 42, departedAt: new Date() }]),
}));

const person = (over: Partial<Person>) => ({
    id: 1,
    email: "robert.miller@example.com",
    googleId: "g-1",
    phone: "5551234567",
    name: "Robert Miller",
    nickname: null,
    dateOfBirth: new Date("1985-01-01"),
    isKeyholder: false,
    isDeclaredAdult: true,
    householdId: 3,
    ...over,
} as Person);

/** Enough of a client for the happy path: facility open, one visit created/closed. */
function fakeDb() {
    return {
        $executeRaw: jest.fn().mockResolvedValue(0),
        boardSettings: { findUnique: jest.fn().mockResolvedValue({ orgMembershipYearBoundary: null, bgRecheckMonths: 0 }) },
        visit: {
            count: jest.fn().mockResolvedValue(1),
            findMany: jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue({ supervisionWarnedAt: null }),
            create: jest.fn().mockResolvedValue({ id: 42 }),
            update: jest.fn().mockResolvedValue({}),
        },
    } as unknown as DbClient;
}

const checkin = async (over: Partial<Person>) =>
    (await processCheckin(person(over), "kiosk", fakeDb())).json();

describe("the scan response's participant", () => {
    it("carries the nickname the person goes by", async () => {
        const body = await checkin({ nickname: "Bo" });
        expect(body.participant).toEqual({ id: 1, name: "Bo" });
    });

    it("falls back to the first name when there is no nickname", async () => {
        const body = await checkin({});
        expect(body.participant).toEqual({ id: 1, name: "Robert" });
    });

    it("falls back to the email prefix when there is no name either", async () => {
        const body = await checkin({ name: "", nickname: null });
        expect(body.participant).toEqual({ id: 1, name: "robert.miller" });
    });

    it("ships no email, phone, googleId or date of birth", async () => {
        const wire = JSON.stringify(await checkin({ nickname: "Bo" }));
        expect(wire).not.toMatch(/email|phone|googleId|dateOfBirth/);
        expect(wire).not.toContain("@example.com");
        expect(wire).not.toContain("5551234567");
    });

    it("is the same DTO on the way out", async () => {
        const res = await processCheckout(person({ nickname: "Bo" }), 42, "kiosk", fakeDb());
        const body = await res.json();
        expect(body.participant).toEqual({ id: 1, name: "Bo" });
        expect(JSON.stringify(body)).not.toContain("@example.com");
    });
});
