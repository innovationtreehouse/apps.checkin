/**
 * @jest-environment node
 */
/**
 * Integration tests for the cancel-event transaction rollback.
 *
 * PATCH /api/events/[id] action 'cancel' deletes RSVPs, nulls the
 * associatedEventId on visits, audits both, then deletes the event, all in one
 * transaction, so a failure mid-way must leave everything untouched — no
 * orphaned visits, no RSVPs deleted under a live event, no audit rows.
 *
 * To force a mid-transaction failure the transaction client's event delete is
 * swapped for a query that errors at the DB (`SELECT 1/0`).
 *
 * Covered:
 *   - single-event cancel: failure rolls back RSVP delete + visit unlink
 *   - applyToFuture series cancel: same rollback across the series
 */
import { PATCH } from '@/app/api/events/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import type { Prisma } from '@/generated/prisma/client';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'cancel-rollback-test';
const HOUR = 60 * 60 * 1000;

function patch(eventId: number, body: Record<string, unknown>) {
    const req = new Request('http://localhost/api/events/x', {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
    return PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(eventId) }) });
}

describe('PATCH /api/events/[id] cancel — transaction rollback on partial failure', () => {
    let participantId: number;
    let householdId: number;
    let adminId: number;
    let adminHouseholdId: number;

    beforeAll(async () => {
        const p = await prisma.person.create({
            data: { name: 'Cancel Attendee', email: `attendee-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        participantId = p.id;
        householdId = p.householdId;

        const admin = await prisma.person.create({
            data: { name: 'Cancel Admin', email: `admin-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        adminId = admin.id;
        adminHouseholdId = admin.householdId;
    });

    beforeEach(() => {
        jest.restoreAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await prisma.visit.deleteMany({ where: { personId: participantId } });
        await prisma.rSVP.deleteMany({ where: { personId: participantId } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: participantId } });
        await prisma.rSVP.deleteMany({ where: { personId: participantId } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { id: { in: [participantId, adminId] } } });
        await prisma.household.deleteMany({ where: { id: { in: [householdId, adminHouseholdId] } } });
    });

    async function makeEvent(label: string, recurringGroupId?: string) {
        const start = new Date(Date.now() + 24 * HOUR);
        const event = await prisma.event.create({
            data: {
                name: `${TAG} ${label}`,
                startAt: start,
                endAt: new Date(start.getTime() + HOUR),
                description: 'cancel',
                ...(recurringGroupId ? { recurringGroupId } : {}),
            },
        });
        await prisma.rSVP.create({
            data: { eventId: event.id, personId: participantId, status: 'ATTENDING' },
        });
        // Closed (departedAt set): makeEvent is called for several events that reuse
        // this one participant, but a participant may have only one OPEN visit
        // (Visit_one_open_per_participant). This test counts visits by
        // associatedEventId, not open-state, so the departure time is irrelevant.
        await prisma.visit.create({
            data: { personId: participantId, arrivedAt: start, departedAt: new Date(start.getTime() + HOUR), associatedEventId: event.id },
        });
        return event.id;
    }

    type TxWork = (tx: Prisma.TransactionClient) => Promise<unknown>;

    /** Runs the next transaction with an event delete that fails at the DB. */
    function failNextEventDelete() {
        const realTransaction = prisma.$transaction.bind(prisma) as (work: TxWork) => Promise<unknown>;
        const failing = (work: TxWork) => realTransaction(tx => work(new Proxy(tx, {
            get(target, prop, receiver) {
                if (prop !== 'event') return Reflect.get(target, prop, receiver);
                return new Proxy(target.event, {
                    get(delegate, method, r) {
                        if (method === 'deleteMany') return () => target.$queryRaw`SELECT 1/0`;
                        return Reflect.get(delegate, method, r);
                    },
                });
            },
        })));
        jest.spyOn(prisma, '$transaction').mockImplementationOnce(failing as typeof prisma.$transaction);
    }

    function counts(eventId: number) {
        return Promise.all([
            prisma.event.count({ where: { id: eventId } }),
            prisma.rSVP.count({ where: { eventId } }),
            prisma.visit.count({ where: { associatedEventId: eventId } }),
        ]);
    }

    it('rolls back the single-event cancel when a write fails mid-transaction', async () => {
        const eventId = await makeEvent('single');
        expect(await counts(eventId)).toEqual([1, 1, 1]);

        failNextEventDelete();

        const res = await patch(eventId, { action: 'cancel' });
        expect(res.status).toBe(500);

        // Nothing committed: event, RSVP, visit link intact, and no audit rows.
        expect(await counts(eventId)).toEqual([1, 1, 1]);
        expect(await prisma.auditLog.count({ where: { actorId: adminId } })).toBe(0);
    });

    it('rolls back the applyToFuture series cancel when a write fails mid-transaction', async () => {
        const group = `${TAG}-group`;
        const first = await makeEvent('series-1', group);
        const second = await makeEvent('series-2', group);
        expect(await counts(first)).toEqual([1, 1, 1]);
        expect(await counts(second)).toEqual([1, 1, 1]);

        failNextEventDelete();

        const res = await patch(first, { action: 'cancel', applyToFuture: true });
        expect(res.status).toBe(500);

        expect(await counts(first)).toEqual([1, 1, 1]);
        expect(await counts(second)).toEqual([1, 1, 1]);
        expect(await prisma.auditLog.count({ where: { actorId: adminId } })).toBe(0);
    });
});
