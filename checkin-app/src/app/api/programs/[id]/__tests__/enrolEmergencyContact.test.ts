/**
 * @jest-environment node
 *
 * A family enrols only with a valid emergency contact on file; a staff roster
 * add is exempt.
 */
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { NO_EMERGENCY_CONTACT_TO_ENROL } from "@/lib/emergencyContacts/service";
import { changeProgramStockWith } from "@/lib/shopify/stock";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { POST as enrol } from "../participants/route";
import { POST as requestPlan } from "../request-payment-plan/route";
import { POST as discountCode } from "../discount-code/route";

process.env.NEXTAUTH_SECRET ||= "enrol-emergency-contact-test-secret";

type SessionUser = { id: number; isSysadmin: boolean; isBoardMember: boolean };
const mockSession: { user: SessionUser } = { user: { id: 2, isSysadmin: false, isBoardMember: false } };
jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown, ctx: unknown) => unknown) =>
        (req: unknown, ctx: unknown) => h(req, { type: "session", user: mockSession.user }, ctx),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        program: { findUnique: jest.fn() },
        person: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
        programParticipant: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
        emergencyContact: { count: jest.fn() },
        auditLog: { create: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
    },
}));
jest.mock("@/lib/shopify/stock", () => ({
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
    changeProgramStockWith: jest.fn((...a: unknown[]) => jest.requireActual("@/test-helpers/stockWith").forwardStockWith(...a)),
    StockNotRecordedError: class extends Error {},
}));
jest.mock("@/lib/program/capacity", () => ({
    ...jest.requireActual("@/lib/program/capacity"),
    lockProgramForClaim: jest.fn(),
}));
jest.mock("@/lib/household/archiveGuard", () => ({ lockLiveHouseholdsOf: jest.fn() }));
jest.mock("@/lib/conflictOfInterest", () => ({
    hasHouseholdConflict: jest.fn().mockResolvedValue(false),
    sharesHousehold: jest.fn(),
}));
jest.mock("@/lib/household/leads", () => ({
    householdLeadship: jest.fn().mockResolvedValue({ householdId: 100, canManage: true }),
}));
jest.mock("@/lib/orgMembership", () => ({
    isMembershipFeeSettled: jest.fn().mockResolvedValue(false),
    isMembershipFeeSettledThrough: jest.fn().mockResolvedValue(false),
    programCoverageDate: jest.fn(),
}));
jest.mock("@/lib/notifications", () => ({ sendNotification: jest.fn() }));
jest.mock("@/lib/scholarshipEmails", () => ({
    resolveScholarshipRecipients: jest.fn().mockResolvedValue([]),
    notifyReviewTeam: jest.fn(),
    sendScholarshipAck: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logIntegrationError: jest.fn(),
}));

const db = prisma as unknown as {
    program: { findUnique: jest.Mock };
    person: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    programParticipant: { findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock };
    emergencyContact: { count: jest.Mock };
    auditLog: { create: jest.Mock };
    boardSettings: { findUnique: jest.Mock };
};

const LEAD = { id: 2, isSysadmin: false, isBoardMember: false };
const BOARD = { id: 1, isSysadmin: false, isBoardMember: true };
const CHILD = 3;
const HOUSEHOLD = 100;
const program = {
    id: 10, name: "Robotics", phase: "UPCOMING", enrollmentStatus: "OPEN", orgMemberOnly: false,
    minAge: null, maxAge: null, startAt: null, offSaleAt: null, saleEndedAt: null, maxParticipants: null,
    orgMemberPriceCents: null, nonOrgMemberPriceCents: null, shopifyVariantId: null, claimantShopifyVariantId: null,
};
const params = { params: Promise.resolve({ id: String(program.id) }) };
const post = (body: unknown) => new Request("http://localhost/api/programs/10", {
    method: "POST", body: JSON.stringify(body),
}) as unknown as NextRequest;

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.user = LEAD;
    db.program.findUnique.mockResolvedValue(program);
    db.person.findUnique.mockResolvedValue({ dateOfBirth: new Date("2015-01-01"), isDeclaredAdult: false, householdId: HOUSEHOLD });
    db.person.findFirst.mockResolvedValue({ id: LEAD.id, dateOfBirth: null, isDeclaredAdult: true });
    db.person.findMany.mockResolvedValue([{ householdId: HOUSEHOLD }]);
    db.programParticipant.findUnique.mockResolvedValue(null);
    db.programParticipant.create.mockResolvedValue({ programId: program.id, personId: CHILD, status: "ACTIVE" });
    db.programParticipant.updateMany.mockResolvedValue({ count: 1 });
    db.boardSettings.findUnique.mockResolvedValue(null);
});

describe("POST /api/programs/[id]/participants", () => {
    it("refuses a family with no valid emergency contact and claims nothing", async () => {
        db.emergencyContact.count.mockResolvedValue(0);
        const res = await enrol(post({ participantId: CHILD }), params);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(NO_EMERGENCY_CONTACT_TO_ENROL);
        expect(db.emergencyContact.count).toHaveBeenCalledWith({ where: expect.objectContaining({ householdId: HOUSEHOLD }) });
        expect(db.programParticipant.create).not.toHaveBeenCalled();
        expect(db.programParticipant.updateMany).not.toHaveBeenCalled();
        expect(changeProgramStockWith).not.toHaveBeenCalled();
    });

    it("enrols a family with a valid emergency contact", async () => {
        db.emergencyContact.count.mockResolvedValue(1);
        const res = await enrol(post({ participantId: CHILD }), params);
        expect(res.status).toBe(200);
        expect(db.programParticipant.create).toHaveBeenCalledTimes(1);
    });

    it("lets staff add a participant from the roster with no emergency contact", async () => {
        mockSession.user = BOARD;
        db.emergencyContact.count.mockResolvedValue(0);
        const res = await enrol(post({ participantId: CHILD, override: true }), params);
        expect(res.status).toBe(200);
        expect(db.programParticipant.create).toHaveBeenCalledTimes(1);
        expect(db.emergencyContact.count).not.toHaveBeenCalled();
    });
});

describe("POST /api/programs/[id]/request-payment-plan", () => {
    beforeEach(() => {
        db.programParticipant.findUnique.mockResolvedValue({
            programId: program.id, personId: CHILD, status: "PENDING", program,
            person: { id: CHILD, name: "Kid", householdId: HOUSEHOLD, dateOfBirth: new Date("2015-01-01"), isDeclaredAdult: false },
        });
    });

    it("refuses a family with no valid emergency contact and holds no seat", async () => {
        db.emergencyContact.count.mockResolvedValue(0);
        const res = await requestPlan(post({ participantId: CHILD, kind: "SCHOLARSHIP" }), params);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(NO_EMERGENCY_CONTACT_TO_ENROL);
        expect(db.programParticipant.updateMany).not.toHaveBeenCalled();
        expect(changeProgramStockWith).not.toHaveBeenCalled();
    });

    it("takes the request for a family with a valid emergency contact", async () => {
        db.emergencyContact.count.mockResolvedValue(1);
        const res = await requestPlan(post({ participantId: CHILD, kind: "SCHOLARSHIP" }), params);
        expect(res.status).toBe(200);
        expect(db.programParticipant.updateMany).toHaveBeenCalled();
    });

    it("lets staff outside the household request one with no emergency contact", async () => {
        mockSession.user = BOARD;
        db.emergencyContact.count.mockResolvedValue(0);
        const res = await requestPlan(post({ participantId: CHILD, kind: "SCHOLARSHIP" }), params);
        expect(res.status).toBe(200);
        expect(db.programParticipant.updateMany).toHaveBeenCalled();
        expect(db.emergencyContact.count).not.toHaveBeenCalled();
    });

    it("refuses staff acting for their own household with no emergency contact", async () => {
        mockSession.user = BOARD;
        (hasHouseholdConflict as jest.Mock).mockResolvedValueOnce(true);
        db.emergencyContact.count.mockResolvedValue(0);
        const res = await requestPlan(post({ participantId: CHILD, kind: "SCHOLARSHIP" }), params);
        expect(res.status).toBe(400);
        expect(db.programParticipant.updateMany).not.toHaveBeenCalled();
    });
});

describe("POST /api/programs/[id]/discount-code", () => {
    it("refuses a family with no valid emergency contact and signs no checkout", async () => {
        db.emergencyContact.count.mockResolvedValue(0);
        const res = await discountCode(post({ participantIds: [CHILD] }), params);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe(NO_EMERGENCY_CONTACT_TO_ENROL);
        expect(body.signature).toBeUndefined();
    });

    it("signs the checkout for a family with a valid emergency contact", async () => {
        db.emergencyContact.count.mockResolvedValue(1);
        const res = await discountCode(post({ participantIds: [CHILD] }), params);
        expect(res.status).toBe(200);
        expect((await res.json()).signature).toEqual(expect.any(String));
    });
});

// A lead acting for a child takes on a payment, so only a known adult lead may.
describe("a household lead who isn't a known adult", () => {
    beforeEach(() => {
        db.emergencyContact.count.mockResolvedValue(1);
        db.programParticipant.findUnique.mockResolvedValue({
            programId: program.id, personId: CHILD, status: "PENDING", program,
            person: { id: CHILD, name: "Kid", householdId: HOUSEHOLD, dateOfBirth: new Date("2015-01-01"), isDeclaredAdult: false },
        });
    });

    it.each([
        ["unknown age", { dateOfBirth: null, isDeclaredAdult: false }, /Add your date of birth/],
        ["a youth", { dateOfBirth: new Date("2012-01-01"), isDeclaredAdult: false }, /under 18/],
    ])("refuses to enroll a child for a lead of %s", async (_label, lead, message) => {
        db.programParticipant.findUnique.mockResolvedValue(null);
        db.person.findFirst.mockResolvedValue(lead);
        const res = await enrol(post({ participantId: CHILD }), params);
        expect(res.status).toBe(403);
        expect((await res.json()).error).toMatch(message);
        expect(db.programParticipant.create).not.toHaveBeenCalled();
    });

    it.each([
        ["unknown age", { dateOfBirth: null, isDeclaredAdult: false }, /Add your date of birth/],
        ["a youth", { dateOfBirth: new Date("2012-01-01"), isDeclaredAdult: false }, /under 18/],
    ])("refuses a payment-plan request from a lead of %s", async (_label, lead, message) => {
        db.person.findFirst.mockResolvedValue(lead);
        const res = await requestPlan(post({ participantId: CHILD, kind: "SCHOLARSHIP" }), params);
        expect(res.status).toBe(403);
        expect((await res.json()).error).toMatch(message);
        expect(db.programParticipant.updateMany).not.toHaveBeenCalled();
    });
});
