/**
 * Placement-regression tests for DELETE /api/attendance (dashboard checkout).
 *
 * The stale-row guard ("Visit already checked out") must sit BELOW the
 * permission check: an unauthorized caller probing a visit id must get an
 * indistinguishable 404, never a 400 that leaks "the visit exists and is
 * already departed."
 */
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { DELETE } from "@/app/api/attendance/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/verify-kiosk", () => ({
    getKioskPublicKeys: jest.fn().mockReturnValue([]),
    verifyKioskSignature: jest.fn().mockReturnValue({ ok: false }),
}));
jest.mock("@/lib/attendanceTransitions", () => ({
    processVisitCheckout: jest.fn().mockResolvedValue([]),
    findAssociatedEventAt: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        visit: { findUnique: jest.fn() },
    },
}));

const mockSession = getServerSession as jest.Mock;
const visitFindUnique = prisma.visit.findUnique as jest.Mock;

const CALLER_ID = 7;
const OTHER_PERSON_ID = 99;

const departedVisit = {
    id: 42,
    personId: OTHER_PERSON_ID,
    deletedAt: null,
    departedAt: new Date("2026-07-20T16:00:00Z"),
    person: { id: OTHER_PERSON_ID, householdId: null, isKeyholder: false },
};

function req(body: unknown) {
    return new Request("http://localhost/api/attendance", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }) as unknown as Parameters<typeof DELETE>[0];
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({
        user: { id: CALLER_ID, isSysadmin: false, isKeyholder: false, isBoardMember: false, householdId: null, householdLead: false },
    });
});

it("returns 404 (not 400) when an unauthorized caller hits a departed visit", async () => {
    visitFindUnique.mockResolvedValue(departedVisit);
    const res = await DELETE(req({ visitId: 42 }), {} as never);
    expect(res.status).toBe(404);
});

it("returns 400 when an authorized caller hits a departed visit", async () => {
    visitFindUnique.mockResolvedValue({ ...departedVisit, personId: CALLER_ID, person: { ...departedVisit.person, id: CALLER_ID } });
    const res = await DELETE(req({ visitId: 42 }), {} as never);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("already checked out");
});
