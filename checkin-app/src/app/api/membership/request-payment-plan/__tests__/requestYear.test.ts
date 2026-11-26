/**
 * @jest-environment node
 *
 * A membership payment-plan request records the year its application is for.
 */
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { POST } from "../route";

jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown) => unknown) =>
        (req: unknown) => h(req, { type: "session", user: { id: 2, isSysadmin: false, isBoardMember: false } }),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        orgMembershipProcess: { findUnique: jest.fn(), updateMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
    },
}));
jest.mock("@/lib/scholarshipEmails", () => ({
    resolveScholarshipRecipients: jest.fn().mockResolvedValue([]), notifyReviewTeam: jest.fn(), sendScholarshipAck: jest.fn(),
}));

const process = {
    id: 7, status: "PENDING_PAYMENT", isPaymentPlanRequested: false,
    orgMembership: { householdId: 5, household: { householdMembers: [{ id: 2 }] } },
};

const post = () => (POST as unknown as (req: NextRequest) => Promise<Response>)(
    new Request("http://localhost/api/membership/request-payment-plan", {
        method: "POST",
        body: JSON.stringify({ processId: 7, kind: "PAYMENT_PLAN" }),
    }) as unknown as NextRequest,
);

beforeEach(() => {
    jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue(process as never);
    jest.mocked(prisma.orgMembershipProcess.updateMany).mockResolvedValue({ count: 1 });
});
afterEach(() => jest.useRealTimers());

it("records the application's own year, not the year live when the family asks", async () => {
    jest.useFakeTimers({ now: new Date(Date.UTC(2027, 6, 5, 12)), doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout"] });
    jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) } as never);
    jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue({ ...process, membershipYear: 2026, createdAt: new Date(Date.UTC(2027, 5, 20)) } as never);

    expect((await post()).status).toBe(200);
    const { where, data } = jest.mocked(prisma.orgMembershipProcess.updateMany).mock.calls.at(-1)![0];
    expect(where).toMatchObject({ isPaymentPlanRequested: false });
    expect(data).toMatchObject({ isPaymentPlanRequested: true, paymentPlanYear: 2026 });
});

it.each([
    ["the day before the renewal window opens", new Date(Date.UTC(2027, 5, 30, 12)), 2026],
    ["the day the renewal window opens", new Date(Date.UTC(2027, 6, 1, 12)), 2027],
])("an application stored without a year records the live year at its creation, %s", async (_label, createdAt, year) => {
    jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) } as never);
    jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue({ ...process, membershipYear: null, createdAt } as never);

    expect((await post()).status).toBe(200);
    expect(jest.mocked(prisma.orgMembershipProcess.updateMany).mock.calls.at(-1)![0].data).toMatchObject({ paymentPlanYear: year });
});

it("records no year for a row without one when no boundary is set", async () => {
    jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue(null);
    jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue({ ...process, membershipYear: null, createdAt: new Date() } as never);

    expect((await post()).status).toBe(200);
    expect(jest.mocked(prisma.orgMembershipProcess.updateMany).mock.calls.at(-1)![0].data).toMatchObject({ paymentPlanYear: null });
});
