/**
 * @jest-environment node
 */
/**
 * DELIVERY guard for the session attendance roster (GET /api/events/[id]).
 *
 * The generic delivery guard (tests/security/delivery.test.ts) runs the stripper
 * over synthetic rows that always carry the binding field, so it cannot see a
 * handler whose `select` omits the scope key — that route-specific assertion is
 * this file. Visit.arrivedAt / departedAt are tier 'personal' and resolve for a
 * program lead / core volunteer through Visit.their_program_participants, keyed
 * on associatedEventId. Drop that column from the select and the roster still
 * returns 200 with a visit row — just one with no times, which the page renders
 * as "Arrived: Invalid Date" and whose manual-edit modal opens blank.
 *
 * The negative case is the one that keeps the grant honest: a lead does NOT get
 * the times on the same person's visit to a session they do not staff.
 */
import { GET as EVENT_GET } from '@/app/api/events/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'event-roster-visit-delivery-test';

function as(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id, isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false },
    });
}
function get(eventId: number) {
    return EVENT_GET(
        new Request(`http://localhost/api/events/${eventId}`) as never,
        { params: Promise.resolve({ id: String(eventId) }) } as never,
    );
}

type RosterVisit = { personId: number; arrivedAt?: string; departedAt?: string | null };

describe('GET /api/events/[id] — roster visit times reach program staff', () => {
    let householdId = 0;
    let leadId = 0, coreVolId = 0, participantId = 0;
    let eventId = 0, otherEventId = 0;

    // Child rows first: a Program cannot be deleted while its enrollment and
    // volunteer join rows still point at it.
    async function wipe() {
        await prisma.visit.deleteMany({ where: { person: { household: { name: { contains: TAG } } } } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.programVolunteer.deleteMany({ where: { program: { name: { contains: TAG } } } });
        await prisma.programParticipant.deleteMany({ where: { program: { name: { contains: TAG } } } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { household: { name: { contains: TAG } } } });
        await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();
        householdId = (await prisma.household.create({ data: { name: `HH ${TAG}` } })).id;
        const person = (name: string) => prisma.person.create({ data: { name: `${name} ${TAG}`, householdId } });
        leadId = (await person('Lead')).id;
        coreVolId = (await person('CoreVol')).id;
        participantId = (await person('Attendee')).id;

        const program = await prisma.program.create({
            data: {
                name: `Prog ${TAG}`,
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                leadMentorId: leadId,
                participants: { create: { personId: participantId } },
                volunteers: { create: { personId: coreVolId, isCore: true } },
            },
        });
        // A program the staff above have nothing to do with — its event is the
        // negative case.
        const otherProgram = await prisma.program.create({
            data: { name: `Other prog ${TAG}`, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31') },
        });

        const makeEvent = (programId: number, label: string) => prisma.event.create({
            data: {
                programId,
                name: `${label} ${TAG}`,
                startAt: new Date('2026-08-01T15:00:00Z'),
                endAt: new Date('2026-08-01T17:00:00Z'),
            },
        });
        eventId = (await makeEvent(program.id, 'Session')).id;
        otherEventId = (await makeEvent(otherProgram.id, 'Foreign session')).id;

        for (const associatedEventId of [eventId, otherEventId]) {
            await prisma.visit.create({
                data: {
                    personId: participantId,
                    associatedEventId,
                    arrivedAt: new Date('2026-08-01T15:05:00Z'),
                    departedAt: new Date('2026-08-01T16:55:00Z'),
                    arrivedVia: 'LEAD_MARKED',
                    departedVia: 'LEAD_MARKED',
                },
            });
        }
    });

    afterAll(async () => {
        await wipe();
    });

    async function rosterVisit(callerId: number, id: number): Promise<RosterVisit> {
        as(callerId);
        const res = await get(id);
        expect(res.status).toBe(200);
        const body = await res.json();
        const visit = (body.visits as RosterVisit[]).find(v => v.personId === participantId);
        expect(visit).toBeDefined();
        return visit!;
    }

    it('delivers arrivedAt and departedAt to the lead mentor', async () => {
        const visit = await rosterVisit(leadId, eventId);
        expect(visit.arrivedAt).toBe('2026-08-01T15:05:00.000Z');
        expect(visit.departedAt).toBe('2026-08-01T16:55:00.000Z');
    });

    it('delivers arrivedAt and departedAt to a core volunteer', async () => {
        const visit = await rosterVisit(coreVolId, eventId);
        expect(visit.arrivedAt).toBe('2026-08-01T15:05:00.000Z');
        expect(visit.departedAt).toBe('2026-08-01T16:55:00.000Z');
    });

    it('does not extend the grant to another program’s session', async () => {
        // The lead is admin/board nowhere, so the foreign event's roster is
        // refused outright — the times are unreachable, not merely stripped.
        as(leadId);
        expect((await get(otherEventId)).status).toBe(403);
    });
});
