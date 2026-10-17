/**
 * @jest-environment node
 */
/**
 * Characterization test for PATCH /api/events/[id] action 'cancel'.
 *
 * eventCancelRollback proves the cancel transaction is atomic, but nothing pins
 * whether cancelling an event NOTIFIES its RSVP'd attendees. As of this commit it
 * does NOT: the cancel path (src/app/api/events/[id]/route.ts) only deletes the
 * RSVPs, nulls visit links, and deletes the event — the route imports no email /
 * notification helper at all. This test documents that deliberate gap: if someone
 * later wires attendee notifications into cancel, the `sendEmail` spy will fire and
 * this test fails, forcing the change to be intentional (update or replace it).
 */
import { PATCH } from '@/app/api/events/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { sendEmail } from '@/lib/email';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'cancel-notify-test';
const HOUR = 60 * 60 * 1000;

function patch(eventId: number, body: Record<string, unknown>) {
    const req = new Request('http://localhost/api/events/x', {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
    return PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(eventId) }) });
}

describe("PATCH /api/events/[id] cancel — attendee notification (characterization)", () => {
    let attendeeId: number;
    let attendeeHouseholdId: number;
    let adminId: number;
    let adminHouseholdId: number;

    beforeAll(async () => {
        const a = await prisma.person.create({
            data: { name: 'Notify Attendee', email: `attendee-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        attendeeId = a.id;
        attendeeHouseholdId = a.householdId;

        const admin = await prisma.person.create({
            data: { name: 'Notify Admin', email: `admin-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        adminId = admin.id;
        adminHouseholdId = admin.householdId;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
    });

    afterEach(async () => {
        await prisma.rSVP.deleteMany({ where: { personId: attendeeId } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
    });

    afterAll(async () => {
        await prisma.rSVP.deleteMany({ where: { personId: attendeeId } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { id: { in: [attendeeId, adminId] } } });
        await prisma.household.deleteMany({ where: { id: { in: [attendeeHouseholdId, adminHouseholdId] } } });
    });

    it('cancels the event and deletes the ATTENDING RSVP but sends NO notification (current behavior)', async () => {
        const start = new Date(Date.now() + 24 * HOUR);
        const event = await prisma.event.create({
            data: { name: `${TAG} future`, startAt: start, endAt: new Date(start.getTime() + HOUR), description: 'cancel' },
        });
        await prisma.rSVP.create({ data: { eventId: event.id, personId: attendeeId, status: 'ATTENDING' } });

        const res = await patch(event.id, { action: 'cancel' });
        expect(res.status).toBe(200);

        // The cancel actually happened: event + its RSVP are gone.
        expect(await prisma.event.count({ where: { id: event.id } })).toBe(0);
        expect(await prisma.rSVP.count({ where: { eventId: event.id } })).toBe(0);

        // ...and the attendee was NOT notified. This is the documented gap.
        expect(sendEmail as jest.Mock).not.toHaveBeenCalled();
    });
});
