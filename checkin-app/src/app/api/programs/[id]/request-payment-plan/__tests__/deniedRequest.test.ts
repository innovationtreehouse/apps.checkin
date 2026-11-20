/**
 * @jest-environment node
 *
 * A denied scholarship or payment-plan request cannot be sent again; the refusal
 * points the family at the finance contact address, or at the Board when it is unset.
 */
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { changeProgramStockWith } from "@/lib/shopify/stock";
import { POST } from "../route";

jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown, ctx: unknown) => unknown) =>
        (req: unknown, ctx: unknown) => h(req, { type: "session", user: { id: 2, isSysadmin: false, isBoardMember: false } }, ctx),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        programParticipant: { findUnique: jest.fn(), updateMany: jest.fn() },
        person: { findFirst: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
    },
}));
jest.mock("@/lib/shopify/stock", () => ({ changeProgramStockWith: jest.fn(), StockNotRecordedError: class extends Error {} }));
jest.mock("@/lib/scholarshipEmails", () => ({
    resolveScholarshipRecipients: jest.fn(), notifyReviewTeam: jest.fn(), sendScholarshipAck: jest.fn(),
}));
jest.mock("@/lib/emergencyContacts/service", () => ({ householdMayEnrol: jest.fn().mockResolvedValue(true), NO_EMERGENCY_CONTACT_TO_ENROL: "" }));

const deniedRow = {
    programId: 10, personId: 3, status: "PENDING", isPaymentPlanRequested: false,
    inventoryHeldAt: new Date(), paymentPlanDeniedAt: new Date(),
    person: { id: 3, name: "Kid", householdId: 5, dateOfBirth: null, isDeclaredAdult: false },
    program: { id: 10, name: "Robotics" },
};

const post = () => (POST as unknown as (req: NextRequest, ctx: unknown) => Promise<Response>)(
    new Request("http://localhost/api/programs/10/request-payment-plan", {
        method: "POST",
        body: JSON.stringify({ participantId: 3, kind: "SCHOLARSHIP" }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: "10" }) },
);

describe("request-payment-plan on a denied place", () => {
    beforeEach(() => {
        jest.mocked(prisma.programParticipant.findUnique).mockResolvedValue(deniedRow as never);
        jest.mocked(prisma.person.findFirst).mockResolvedValue({ id: 2, dateOfBirth: null, isDeclaredAdult: true } as never); // the household lead, a declared adult
    });

    it.each([
        ["names the finance contact address when it is set", { financeContactEmail: " finance@example.org " }, /please email finance at finance@example\.org\./],
        ["points at the Board when the address is unset", { financeContactEmail: null }, /please contact the Board\./],
        ["points at the Board when the address is blank", { financeContactEmail: "  " }, /please contact the Board\./],
        ["points at the Board when there is no settings row", null, /please contact the Board\./],
    ])("refuses with 409 and %s, writing nothing", async (_name, settings, followUp) => {
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue(settings as never);
        const res = await post();
        expect(res.status).toBe(409);
        const { error } = await res.json();
        expect(error).toMatch(/was not approved, so it can't be sent again\. You can still pay for the place\./);
        expect(error).toMatch(followUp);
        if (!settings?.financeContactEmail?.trim()) expect(error).not.toMatch(/@/);
        expect(changeProgramStockWith).not.toHaveBeenCalled();
        expect(prisma.programParticipant.updateMany).not.toHaveBeenCalled();
    });

    it("refuses with 409 when the denial commits after the route read the row", async () => {
        jest.mocked(prisma.programParticipant.findUnique)
            .mockResolvedValueOnce({ ...deniedRow, isPaymentPlanRequested: true, paymentPlanDeniedAt: null } as never)
            .mockResolvedValueOnce({ paymentPlanDeniedAt: new Date() } as never);
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ financeContactEmail: "finance@example.org" } as never);
        jest.mocked(changeProgramStockWith).mockResolvedValue(null as never); // both writes match nothing

        const res = await post();
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/was not approved/);
    });
});
