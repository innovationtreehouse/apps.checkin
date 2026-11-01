/**
 * @jest-environment node
 */
/**
 * Integration tests for attendanceTransitions.ts — the visit-chunking state
 * machine that splits one open visit into multiple event-associated + gap
 * visits inside a $transaction. The scan tests only hit the no-events path;
 * these cover the boundary math (gap-before, back-to-back events,
 * already-closed/missing visits).
 */
import { findAssociatedEventAt, processVisitCheckout } from '@/lib/attendanceTransitions';
import { MAX_VISIT_MS } from '@/lib/visitTimes';
import prisma from '@/lib/prisma';

const TAG = 'attendance-transitions-test';
const HOUR = 60 * 60 * 1000;

describe('attendanceTransitions', () => {
    let programId: number;
    let participantId: number;
    let unenrolledId: number;
    const householdIds: number[] = [];

    beforeAll(async () => {
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `AT Program ${TAG}`, enrollmentStatus: 'OPEN' },
        });
        programId = program.id;

        const p = await prisma.person.create({
            data: { name: 'AT Enrolled', email: `enrolled-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        participantId = p.id;
        householdIds.push(p.householdId);
        await prisma.programParticipant.create({
            data: { programId, personId: participantId, status: 'ACTIVE', pendingSince: null },
        });

        const u = await prisma.person.create({
            data: { name: 'AT Unenrolled', email: `unenrolled-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        unenrolledId = u.id;
        householdIds.push(u.householdId);
    });

    afterEach(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: [participantId, unenrolledId] } } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { id: { in: [participantId, unenrolledId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    function makeEvent(label: string, start: Date, end: Date) {
        return prisma.event.create({
            data: { name: `${TAG} ${label}`, programId, startAt: start, endAt: end, description: 'x' },
        });
    }

    describe('findAssociatedEventAt', () => {
        it('returns null for a participant enrolled in no programs', async () => {
            const id = await findAssociatedEventAt(unenrolledId, new Date());
            expect(id).toBeNull();
        });

        it('matches an event that is currently ongoing', async () => {
            const now = new Date();
            const ev = await makeEvent('ongoing', new Date(now.getTime() - HOUR), new Date(now.getTime() + HOUR));
            const id = await findAssociatedEventAt(participantId, now);
            expect(id).toBe(ev.id);
        });

        it('matches an event starting within the next 4 hours', async () => {
            const now = new Date();
            const ev = await makeEvent('soon', new Date(now.getTime() + 3 * HOUR), new Date(now.getTime() + 4 * HOUR));
            const id = await findAssociatedEventAt(participantId, now);
            expect(id).toBe(ev.id);
        });

        it('does NOT match an event starting more than 4 hours out', async () => {
            const now = new Date();
            await makeEvent('far', new Date(now.getTime() + 5 * HOUR), new Date(now.getTime() + 6 * HOUR));
            const id = await findAssociatedEventAt(participantId, now);
            expect(id).toBeNull();
        });

        it('returns the soonest of several matching events', async () => {
            const now = new Date();
            const soon = await makeEvent('a-soon', new Date(now.getTime() + HOUR), new Date(now.getTime() + 2 * HOUR));
            await makeEvent('b-later', new Date(now.getTime() + 3 * HOUR), new Date(now.getTime() + 4 * HOUR));
            const id = await findAssociatedEventAt(participantId, now);
            expect(id).toBe(soon.id);
        });
    });

    describe('processVisitCheckout', () => {
        it('closes a plain visit with no events into a single departedAt visit', async () => {
            const arrivedAt = new Date(Date.now() - 2 * HOUR);
            const checkout = new Date();
            const visit = await prisma.visit.create({ data: { personId: participantId, arrivedAt } });

            const result = await processVisitCheckout(visit.id, checkout, prisma, "TYPED");
            expect(result).toHaveLength(1);
            expect(result[0].departedAt).toEqual(checkout);
            expect(result[0].associatedEventId).toBeNull();
        });

        it('chunks a stay around one mid-stay event into a gap visit + an event visit', async () => {
            const t0 = new Date(Date.now() - 4 * HOUR);
            const eventStart = new Date(t0.getTime() + HOUR);
            const eventEnd = new Date(t0.getTime() + 2 * HOUR);
            const checkout = new Date(t0.getTime() + 3 * HOUR);
            const ev = await makeEvent('mid', eventStart, eventEnd);
            const visit = await prisma.visit.create({ data: { personId: participantId, arrivedAt: t0 } });

            const result = await processVisitCheckout(visit.id, checkout, prisma, "TYPED");

            // Original open visit is replaced by the chunks.
            const original = await prisma.visit.findUnique({ where: { id: visit.id } });
            expect(original).toBeNull();

            const gap = result.find(v => v.associatedEventId === null);
            const eventVisit = result.find(v => v.associatedEventId === ev.id);
            expect(gap).toBeDefined();
            expect(eventVisit).toBeDefined();
            // Gap covers arrival → event start; event visit covers event start → checkout.
            expect(gap!.arrivedAt).toEqual(t0);
            expect(gap!.departedAt).toEqual(eventStart);
            expect(eventVisit!.arrivedAt).toEqual(eventStart);
            expect(eventVisit!.departedAt).toEqual(checkout);
        });

        it('splits back-to-back events into adjacent event visits at the handoff', async () => {
            const t0 = new Date(Date.now() - 5 * HOUR);
            const e1Start = new Date(t0.getTime() + HOUR);
            const e1End = new Date(t0.getTime() + 2 * HOUR);
            const e2Start = new Date(t0.getTime() + 2 * HOUR);
            const e2End = new Date(t0.getTime() + 3 * HOUR);
            const checkout = new Date(t0.getTime() + 4 * HOUR);
            const e1 = await makeEvent('back1', e1Start, e1End);
            const e2 = await makeEvent('back2', e2Start, e2End);
            const visit = await prisma.visit.create({ data: { personId: participantId, arrivedAt: t0 } });

            const result = await processVisitCheckout(visit.id, checkout, prisma, "TYPED");

            const v1 = result.find(v => v.associatedEventId === e1.id);
            const v2 = result.find(v => v.associatedEventId === e2.id);
            expect(v1).toBeDefined();
            expect(v2).toBeDefined();
            // Handoff: e1 visit ends exactly where e2 visit begins.
            expect(v1!.departedAt).toEqual(e2Start);
            expect(v2!.arrivedAt).toEqual(e2Start);
            expect(v2!.departedAt).toEqual(checkout);
        });

        it('caps a stamped-now close at MAX_VISIT_MS after arrival', async () => {
            const arrivedAt = new Date(Date.now() - 30 * HOUR);
            const visit = await prisma.visit.create({ data: { personId: unenrolledId, arrivedAt } });

            const result = await processVisitCheckout(visit.id, new Date(), undefined, 'AUTO_CLOSE');

            expect(result).toHaveLength(1);
            expect(result[0].departedAt).toEqual(new Date(arrivedAt.getTime() + MAX_VISIT_MS));
            expect(result[0].departedVia).toBe('AUTO_CLOSE');
        });

        it('caps the chunked span as a whole: an event past the cap yields no chunk', async () => {
            const t0 = new Date(Date.now() - 30 * HOUR);
            const cap = new Date(t0.getTime() + MAX_VISIT_MS);
            const early = await makeEvent('capped-early', new Date(t0.getTime() + HOUR), new Date(t0.getTime() + 2 * HOUR));
            // Starts after the cap but before the uncapped checkout time.
            await makeEvent('capped-late', new Date(cap.getTime() + HOUR), new Date(cap.getTime() + 2 * HOUR));
            const visit = await prisma.visit.create({ data: { personId: participantId, arrivedAt: t0 } });

            const result = await processVisitCheckout(visit.id, new Date(), undefined, 'AUTO_CLOSE');

            // Gap then the early event, ending at the cap — the late event is out of span.
            expect(result.map(v => v.associatedEventId)).toEqual([null, early.id]);
            expect(result[0].arrivedAt).toEqual(t0);
            expect(result[result.length - 1].departedAt).toEqual(cap);
        });

        it('closes a checkout at or before arrival as a zero-length visit, never deleting it', async () => {
            const t0 = new Date(Date.now() - HOUR);
            await makeEvent('covering', new Date(t0.getTime() - HOUR), new Date(t0.getTime() + HOUR));
            const visit = await prisma.visit.create({ data: { personId: participantId, arrivedAt: t0 } });

            const result = await processVisitCheckout(visit.id, new Date(t0.getTime() - 60_000), prisma, "TYPED");

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe(visit.id);
            expect(result[0].departedAt).toEqual(t0);
            const row = await prisma.visit.findUnique({ where: { id: visit.id } });
            expect(row?.departedAt).toEqual(t0);
            expect(row?.departedVia).toBe('TYPED');
        });

        it('returns [] for an already-departedAt visit (idempotent)', async () => {
            const visit = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: new Date(Date.now() - HOUR), departedAt: new Date() },
            });
            const result = await processVisitCheckout(visit.id, new Date(), prisma, "TYPED");
            expect(result).toEqual([]);
        });

        it('returns [] for a non-existent visit id', async () => {
            const result = await processVisitCheckout(99999999, new Date(), prisma, "TYPED");
            expect(result).toEqual([]);
        });
    });
});
