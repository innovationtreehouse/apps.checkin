/**
 * @jest-environment node
 *
 * GET /api/programs/[id] shapes its roster fetch on the view handler() resolves:
 * staff and an enrolled household receive the roster rows; a signed-in caller
 * outside the program and an anonymous caller receive counts only, and their
 * query never selects the participant models.
 */
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/programs/[id]/route";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        program: { findUnique: jest.fn(), findMany: jest.fn() },
        programVolunteer: { findMany: jest.fn() },
        programParticipant: { findMany: jest.fn() },
        person: { findMany: jest.fn(), findFirst: jest.fn() },
        event: { findMany: jest.fn() },
    },
}));
jest.mock("@/lib/orgMembership", () => ({
    isActiveOrgMember: jest.fn(async () => false),
    isMembershipFeeSettled: jest.fn(async () => false),
    isMembershipFeeSettledThrough: jest.fn(async () => false),
    programCoverageDate: jest.fn(async () => new Date("2026-12-31T00:00:00Z")),
}));

const mockSession = getServerSession as jest.Mock;
const db = prisma as unknown as {
    program: { findUnique: jest.Mock; findMany: jest.Mock };
    programVolunteer: { findMany: jest.Mock };
    programParticipant: { findMany: jest.Mock };
    person: { findMany: jest.Mock; findFirst: jest.Mock };
    event: { findMany: jest.Mock };
};

const PROGRAM_ID = 100;
const HOUSEHOLD_ID = 42;
const PARENT_ID = 50;

const ROW = {
    id: PROGRAM_ID, name: "Robotics", leadMentorId: 10,
    startAt: new Date("2026-09-01T00:00:00Z"), endAt: new Date("2026-12-31T00:00:00Z"),
    appliesToYear: 2026, offSaleAt: null, phase: "RUNNING", enrollmentStatus: "OPEN",
    orgMemberOnly: false, publiclyVisible: true, announceOnOpen: false, minAge: null, maxAge: null,
    maxParticipants: 10, orgMemberPriceCents: null, nonOrgMemberPriceCents: null,
    shopifyProductId: null, shopifyVariantId: null, claimantShopifyVariantId: null,
    volunteers: [{ programId: PROGRAM_ID, personId: 11, isCore: true, person: { id: 11, name: "Vol", email: "vol@example.com" } }],
    participants: [{
        programId: PROGRAM_ID, personId: 1, status: "ACTIVE", pendingSince: null,
        person: {
            id: 1, name: "Kid", email: null, phone: null, dateOfBirth: new Date("2014-01-01T00:00:00Z"),
            isDeclaredAdult: false, householdId: HOUSEHOLD_ID,
            household: { id: HOUSEHOLD_ID, householdMembers: [], emergencyContacts: [] },
        },
    }],
    events: [],
    leadMentor: { id: 10, name: "Lead", email: "lead@example.com" },
    _count: { participants: 1, volunteers: 1 },
};

const ROLES = { isSysadmin: false, isBoardMember: false, isKeyholder: false };
const signIn = (user: object | null) => mockSession.mockResolvedValue(user && { user: { ...ROLES, ...user } });

beforeEach(() => {
    jest.clearAllMocks();
    db.program.findUnique.mockImplementation(async ({ select }: { select: Record<string, unknown> }) =>
        Object.fromEntries(Object.entries(ROW).filter(([k]) => k in select)));
    db.program.findMany.mockResolvedValue([]);
    db.programVolunteer.findMany.mockResolvedValue([]);
    db.programParticipant.findMany.mockResolvedValue([]);
    db.person.findMany.mockResolvedValue([]);
    db.person.findFirst.mockResolvedValue(null);
    db.event.findMany.mockResolvedValue([]);
});

async function get() {
    const res = await GET(new Request(`http://localhost/api/programs/${PROGRAM_ID}`) as never, { params: Promise.resolve({ id: String(PROGRAM_ID) }) });
    expect(res.status).toBe(200);
    return res.json();
}

type Select = Record<string, unknown>;
const selects = (): Select[] => db.program.findUnique.mock.calls.map(([args]: [{ select: Select }]) => args.select);

describe("GET /api/programs/[id] — roster fetch follows the resolved view", () => {
    it("an enrolled household receives the roster rows", async () => {
        signIn({ id: PARENT_ID, householdId: HOUSEHOLD_ID });
        db.programParticipant.findMany.mockResolvedValue([{ programId: PROGRAM_ID }]);

        const body = await get();

        expect(body.participants.map((p: { personId: number }) => p.personId)).toEqual([1]);
        expect(selects().some(s => "participants" in s && "volunteers" in s)).toBe(true);
    });

    it("board receives the roster rows", async () => {
        signIn({ id: 77, householdId: 8, isBoardMember: true });

        const body = await get();

        expect(body.participants.map((p: { personId: number }) => p.personId)).toEqual([1]);
        expect(body.volunteers.map((v: { personId: number }) => v.personId)).toEqual([11]);
    });

    it.each([
        ["a signed-in caller outside the program", () => signIn({ id: 99, householdId: 7 })],
        ["an anonymous caller", () => signIn(null)],
    ])("%s gets counts only and never selects the participant models", async (_who, as) => {
        as();

        const body = await get();

        expect(body).not.toHaveProperty("participants");
        expect(body).not.toHaveProperty("volunteers");
        expect(body._count).toEqual({ participants: 1, volunteers: 1 });
        expect(selects()).toHaveLength(1);
        expect(selects()[0]).not.toHaveProperty("participants");
        expect(selects()[0]).not.toHaveProperty("volunteers");
    });
});
