/**
 * @jest-environment node
 *
 * Board ruling B15, 2026-10-27: the program and event rosters withhold a
 * participant's own email from the program's lead mentor and core volunteers
 * while the participant is under 13, judged in the API response. Sysadmin and
 * board keep it; parents' contact details are untouched.
 */
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET as programGET } from "@/app/api/programs/[id]/route";
import { GET as eventGET } from "@/app/api/events/[id]/route";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        program: { findUnique: jest.fn(), findMany: jest.fn() },
        programVolunteer: { findMany: jest.fn() },
        person: { findMany: jest.fn(), findFirst: jest.fn() },
        event: { findUnique: jest.fn(), findMany: jest.fn() },
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
    person: { findMany: jest.Mock; findFirst: jest.Mock };
    event: { findUnique: jest.Mock; findMany: jest.Mock };
};

const PROGRAM_ID = 100;
const EVENT_ID = 200;
const LEAD_ID = 10;
const HOUSEHOLD_ID = 42;

const kid = (id: number, dateOfBirth: Date | null) => ({ id, name: `Kid ${id}`, email: `kid${id}@example.com`, dateOfBirth, householdId: HOUSEHOLD_ID });
// Today is 2026-10-27 in the org's zone.
const UNDER_13 = kid(1, new Date("2013-10-28T00:00:00Z"));
const EXACTLY_13 = kid(2, new Date("2013-10-27T00:00:00Z"));
const UNKNOWN_DOB = kid(3, null);
const KIDS = [UNDER_13, EXACTLY_13, UNKNOWN_DOB];
const PARENT = { id: 50, householdId: HOUSEHOLD_ID, isHouseholdLead: true, name: "Parent", email: "parent@example.com", phone: "5125551234" };

function programRow(householdMembers: object[] = [PARENT]) {
    return {
        id: PROGRAM_ID, name: "Robotics", leadMentorId: LEAD_ID,
        startAt: new Date("2026-09-01T00:00:00Z"), endAt: new Date("2026-12-31T00:00:00Z"),
        appliesToYear: null, offSaleAt: null, phase: "RUNNING", enrollmentStatus: "OPEN",
        orgMemberOnly: false, publiclyVisible: true, announceOnOpen: false, minAge: null, maxAge: null,
        maxParticipants: null, orgMemberPriceCents: null, nonOrgMemberPriceCents: null,
        shopifyProductId: null, shopifyVariantId: null, claimantShopifyVariantId: null,
        volunteers: [],
        participants: KIDS.map(({ householdId, ...k }) => ({
            programId: PROGRAM_ID, personId: k.id, status: "ACTIVE", pendingSince: null,
            person: { ...k, householdId, household: { id: HOUSEHOLD_ID, householdMembers, emergencyContacts: [] } },
        })),
        events: [],
        leadMentor: { id: LEAD_ID, name: "Lead", email: "lead@example.com" },
        _count: { participants: KIDS.length, volunteers: 0 },
    };
}

function eventRow() {
    return {
        id: EVENT_ID, programId: PROGRAM_ID, name: "Session 1",
        startAt: new Date("2026-10-20T23:00:00Z"), endAt: new Date("2026-10-21T01:00:00Z"),
        attendanceConfirmedAt: null, recurringGroupId: null, attendanceConfirmedBy: null,
        program: {
            id: PROGRAM_ID, name: "Robotics", leadMentorId: LEAD_ID, volunteers: [],
            participants: KIDS.map(({ householdId: _h, ...k }) => ({ programId: PROGRAM_ID, personId: k.id, status: "ACTIVE", person: k })),
        },
        visits: [], rsvps: [],
    };
}

const ROLES = { isSysadmin: false, isBoardMember: false, isKeyholder: false };
const asLead = () => mockSession.mockResolvedValue({ user: { ...ROLES, id: LEAD_ID, householdId: 9 } });
const asBoard = () => mockSession.mockResolvedValue({ user: { ...ROLES, id: 77, householdId: 8, isBoardMember: true } });
const asSysadmin = () => mockSession.mockResolvedValue({ user: { ...ROLES, id: 78, householdId: 8, isSysadmin: true } });

beforeAll(() => {
    jest.useFakeTimers({ now: new Date("2026-10-27T17:00:00Z"), doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"] });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
    jest.clearAllMocks();
    db.program.findUnique.mockResolvedValue(programRow());
    db.event.findUnique.mockResolvedValue(eventRow());
    db.programVolunteer.findMany.mockResolvedValue([]);
    db.event.findMany.mockResolvedValue([{ id: EVENT_ID }]);
    db.person.findMany.mockResolvedValue([{ householdId: HOUSEHOLD_ID }]);
    db.person.findFirst.mockResolvedValue({ householdId: 8 });
    db.program.findMany.mockImplementation(async ({ where }: { where: { leadMentorId: number } }) =>
        where.leadMentorId === LEAD_ID ? [{ id: PROGRAM_ID, participants: KIDS.map(k => ({ personId: k.id })) }] : []);
});

type RosterRow = { personId: number; person: { email?: string | null; dateOfBirth?: unknown; household?: { householdMembers: { id: number; email?: string | null }[] } } };

async function programRoster(): Promise<RosterRow[]> {
    const res = await programGET(new Request(`http://localhost/api/programs/${PROGRAM_ID}`) as never, { params: Promise.resolve({ id: String(PROGRAM_ID) }) });
    expect(res.status).toBe(200);
    return (await res.json()).participants;
}

async function eventRoster(): Promise<RosterRow[]> {
    const res = await eventGET(new Request(`http://localhost/api/events/${EVENT_ID}`) as never, { params: Promise.resolve({ id: String(EVENT_ID) }) });
    expect(res.status).toBe(200);
    return (await res.json()).program.participants;
}

const emails = (rows: RosterRow[]) => Object.fromEntries(rows.map(r => [r.personId, r.person.email ?? null]));

describe.each([
    ["GET /api/programs/[id]", programRoster],
    ["GET /api/events/[id]", eventRoster],
])("%s — participant email under 13 (B15)", (_name, roster) => {
    it("hides under 13 and unknown DOB from the lead mentor; shows exactly 13", async () => {
        asLead();
        expect(emails(await roster())).toEqual({
            [UNDER_13.id]: null,
            [EXACTLY_13.id]: EXACTLY_13.email,
            [UNKNOWN_DOB.id]: null,
        });
    });

    it.each([["board", asBoard], ["sysadmin", asSysadmin]])("leaves every email visible to %s", async (_role, as) => {
        as();
        expect(emails(await roster())).toEqual({
            [UNDER_13.id]: UNDER_13.email,
            [EXACTLY_13.id]: EXACTLY_13.email,
            [UNKNOWN_DOB.id]: UNKNOWN_DOB.email,
        });
    });

    it("never ships the date of birth it reads", async () => {
        asLead();
        for (const row of await roster()) expect(row.person).not.toHaveProperty("dateOfBirth");
    });
});

it("keeps the parent's email on the program roster for the lead mentor", async () => {
    asLead();
    const rows = await programRoster();
    const under13 = rows.find(r => r.personId === UNDER_13.id);
    expect(under13?.person.household?.householdMembers[0].email).toBe(PARENT.email);
});

describe("an enrolled participant who is also a household lead", () => {
    const lead = ({ id, email }: { id: number; email: string }) => ({ id, householdId: HOUSEHOLD_ID, isHouseholdLead: true, name: `Kid ${id}`, email, phone: "5125551234" });
    const leadList = async () => {
        const rows = await programRoster();
        const members = rows[0].person.household?.householdMembers ?? [];
        return Object.fromEntries(members.map(m => [m.id, m.email ?? null]));
    };

    beforeEach(() => {
        db.program.findUnique.mockResolvedValue(programRow([lead(UNDER_13), lead(EXACTLY_13), lead(UNKNOWN_DOB), PARENT]));
    });

    it("follows the participant rule in the household's lead list for the lead mentor; guardians keep theirs", async () => {
        asLead();
        expect(await leadList()).toEqual({
            [UNDER_13.id]: null,
            [EXACTLY_13.id]: EXACTLY_13.email,
            [UNKNOWN_DOB.id]: null,
            [PARENT.id]: PARENT.email,
        });
    });

    it("leaves the lead list whole for the board", async () => {
        asBoard();
        expect(await leadList()).toEqual({
            [UNDER_13.id]: UNDER_13.email,
            [EXACTLY_13.id]: EXACTLY_13.email,
            [UNKNOWN_DOB.id]: UNKNOWN_DOB.email,
            [PARENT.id]: PARENT.email,
        });
    });
});
