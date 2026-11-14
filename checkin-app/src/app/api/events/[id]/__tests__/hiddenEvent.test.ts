/**
 * @jest-environment node
 *
 * An event the caller does not staff answers exactly as a missing one does, on
 * GET and PATCH, so a signed-in user cannot learn which event ids exist.
 */
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET, PATCH } from "@/app/api/events/[id]/route";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        event: { findUnique: jest.fn(), findMany: jest.fn() },
        program: { findMany: jest.fn() },
        programVolunteer: { findMany: jest.fn() },
        person: { findMany: jest.fn(), findFirst: jest.fn() },
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
    event: { findUnique: jest.Mock; findMany: jest.Mock };
    program: { findMany: jest.Mock };
    programVolunteer: { findMany: jest.Mock };
    person: { findMany: jest.Mock; findFirst: jest.Mock };
};

const EVENT_ID = 200;
const STRANGER_ID = 30;

const event = {
    id: EVENT_ID, programId: 100, name: "Session 1",
    startAt: new Date("2030-01-01T10:00:00Z"), endAt: new Date("2030-01-01T12:00:00Z"),
    attendanceConfirmedAt: null, recurringGroupId: null, attendanceConfirmedBy: null,
    program: { id: 100, name: "Robotics", leadMentorId: 10, volunteers: [], participants: [] },
    visits: [], rsvps: [],
};

const ctx = { params: Promise.resolve({ id: String(EVENT_ID) }) };
const get = () => GET(new Request(`http://localhost/api/events/${EVENT_ID}`) as never, ctx);
const patch = (action: string) => PATCH(
    new Request(`http://localhost/api/events/${EVENT_ID}`, { method: "PATCH", body: JSON.stringify({ action }) }) as never,
    ctx,
);
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: STRANGER_ID, householdId: 9, isSysadmin: false, isBoardMember: false, isKeyholder: false } });
    db.event.findMany.mockResolvedValue([]);
    db.program.findMany.mockResolvedValue([]);
    db.programVolunteer.findMany.mockResolvedValue([]);
    db.person.findMany.mockResolvedValue([]);
    db.person.findFirst.mockResolvedValue({ householdId: 9 });
});

async function existingThenMissing(call: () => Promise<Response>) {
    db.event.findUnique.mockResolvedValue(event);
    const existing = await answer(await call());
    db.event.findUnique.mockResolvedValue(null);
    const missing = await answer(await call());
    return { existing, missing };
}

it("GET answers 404 to a non-staff caller on an existing event, as for a missing one", async () => {
    const { existing, missing } = await existingThenMissing(get);
    expect(existing.status).toBe(404);
    expect(existing).toEqual(missing);
});

it.each(["confirmAttendance", "cancel", "manualEditAttendance", "noSuchAction"])(
    "PATCH %s answers 404 to a non-staff caller on an existing event, as for a missing one",
    async (action) => {
        const { existing, missing } = await existingThenMissing(() => patch(action));
        expect(existing.status).toBe(404);
        expect(existing).toEqual(missing);
    },
);
