/**
 * @jest-environment node
 *
 * A repeat membership payment-plan request with a new kind corrects the stored kind
 * and re-notifies the review team; any other repeat changes nothing.
 */
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { notifyReviewTeam, sendScholarshipAck } from "@/lib/scholarshipEmails";
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

const requested = (scholarshipRequestKind: string | null) => ({
    id: 7, status: "PENDING_PAYMENT", isPaymentPlanRequested: true, scholarshipRequestKind,
    zohoRecordId: "internal-zoho-id",
    orgMembership: { householdId: 5, household: { householdMembers: [{ id: 2 }] } },
});

const post = (body: Record<string, unknown>) => (POST as unknown as (req: NextRequest) => Promise<Response>)(
    new Request("http://localhost/api/membership/request-payment-plan", {
        method: "POST",
        body: JSON.stringify({ processId: 7, ...body }),
    }) as unknown as NextRequest,
);

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(prisma.orgMembershipProcess.updateMany).mockResolvedValue({ count: 1 });
});

it.each([
    ["a different kind", "PAYMENT_PLAN"],
    ["a kind where none was recorded", null],
])("a repeat with %s updates the kind and notifies the review team once", async (_label, stored) => {
    jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue(requested(stored) as never);

    const res = await post({ kind: "SCHOLARSHIP" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = jest.mocked(prisma.orgMembershipProcess.updateMany).mock.calls[0][0];
    expect(where).toMatchObject({ id: 7, status: "PENDING_PAYMENT", isPaymentPlanRequested: true, scholarshipRequestKind: stored });
    expect(data).toEqual({ scholarshipRequestKind: "SCHOLARSHIP" });

    expect(notifyReviewTeam).toHaveBeenCalledTimes(1);
    expect(jest.mocked(notifyReviewTeam).mock.calls[0][0]).toBe("scholarship.membershipReview");
    expect(jest.mocked(notifyReviewTeam).mock.calls[0][1]).toMatchObject({ householdId: "5", requestKind: "Scholarship" });
    expect(sendScholarshipAck).not.toHaveBeenCalled();
});

it.each([
    ["the same kind", { kind: "PAYMENT_PLAN" }],
    ["no kind", {}],
    ["a null kind", { kind: null }],
])("a repeat with %s writes nothing and sends nothing", async (_label, body) => {
    jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue(requested("PAYMENT_PLAN") as never);

    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    expect(notifyReviewTeam).not.toHaveBeenCalled();
    expect(sendScholarshipAck).not.toHaveBeenCalled();
});

it("the losing half of two concurrent corrections sends nothing", async () => {
    jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue(requested("PAYMENT_PLAN") as never);
    jest.mocked(prisma.orgMembershipProcess.updateMany).mockResolvedValue({ count: 0 });

    const res = await post({ kind: "UNSURE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = jest.mocked(prisma.orgMembershipProcess.updateMany).mock.calls[0][0];
    expect(where).toMatchObject({ id: 7, status: "PENDING_PAYMENT", isPaymentPlanRequested: true, scholarshipRequestKind: "PAYMENT_PLAN" });
    expect(data).toEqual({ scholarshipRequestKind: "UNSURE" });
    expect(notifyReviewTeam).not.toHaveBeenCalled();
    expect(sendScholarshipAck).not.toHaveBeenCalled();
});
