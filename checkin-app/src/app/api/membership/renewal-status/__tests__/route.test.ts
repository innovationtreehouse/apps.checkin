/**
 * @jest-environment node
 *
 * The renewal banner's due date is the boundary that opens the renewal's stored year, and
 * says it was due once that date is past.
 */
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { GET } from "../route";

jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown) => unknown) =>
        (req: unknown) => h(req, { type: "session", user: { id: 2 } }),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        orgMembershipProcess: { findFirst: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
    },
}));

const get = async () => (await (GET as unknown as (req: NextRequest) => Promise<Response>)(new Request("http://localhost/api/membership/renewal-status") as unknown as NextRequest)).json();
const at = (date: Date) => jest.useFakeTimers({ now: date, doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout"] });

beforeEach(() => {
    jest.mocked(prisma.person.findUnique).mockResolvedValue({ householdId: 5, isHouseholdLead: true } as never);
    jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) } as never);
});
afterEach(() => jest.useRealTimers());

const renewal = (membershipYear: number | null, createdAt: Date) =>
    jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue({ kind: "RENEWAL", membershipYear, createdAt, orgMembership: { notRenewingYear: null } } as never);

it("is due at the boundary that opens the renewal's year", async () => {
    at(new Date(Date.UTC(2026, 6, 15, 12)));
    renewal(2026, new Date(Date.UTC(2026, 6, 2)));
    await expect(get()).resolves.toEqual({ renewalDue: true, dueDate: "2026-09-01", wasDue: false, notRenewing: false });
});

it("says a renewal opened for the year already under way was due", async () => {
    at(new Date(Date.UTC(2026, 9, 10, 12)));
    renewal(2026, new Date(Date.UTC(2026, 9, 5)));
    await expect(get()).resolves.toMatchObject({ dueDate: "2026-09-01", wasDue: true });
});

it("a renewal stored without a year is due at the next boundary after its creation", async () => {
    at(new Date(Date.UTC(2026, 6, 15, 12)));
    renewal(null, new Date(Date.UTC(2026, 6, 2)));
    await expect(get()).resolves.toMatchObject({ dueDate: "2026-09-01", wasDue: false });
});
