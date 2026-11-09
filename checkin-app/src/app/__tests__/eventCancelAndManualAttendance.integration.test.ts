/**
 * @jest-environment node
 */
/**
 * Integration tests for three write paths in PATCH /api/events/[id] that can
 * corrupt attendance / safety data:
 *
 *   1. CANCEL (single + recurring series) — transactional; visits NULLed, not deleted.
 *   2. manualEditAttendance vs. an OPEN scan visit (Present links / Absent rejects).
 *   3. PAST-EVENT edit guard (editTime on a finished event is rejected).
 *
 * A manual "Absent" must not delete a live check-in: an Absent
 * edit against an OPEN visit (departedAt = null) is rejected with 400 so the row
 * proving the participant is physically on-site survives. Only CLOSED visits are
 * removed on an Absent correction. See the manualEditAttendance block below.
 */
import { PATCH } from '@/app/api/events/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'event-cancel-manual-test';
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function patch(eventId: number, body: Record<string, unknown>) {
    const req = new Request('http://localhost/api/events/x', {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
    return PATCH(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(eventId) }) });
}

describe('PATCH /api/events/[id] — cancel, manual attendance, past-event guard', () => {
    let adminId: number;
    let adminHouseholdId: number;
    let participantId: number;
    let householdId: number;

    beforeAll(async () => {
        const admin = await prisma.person.create({
            data: { name: 'Cancel Admin', email: `admin-${TAG}@example.com`, isSysadmin: true, household: { create: { name: "Test HH" } } },
        });
        adminId = admin.id;
        adminHouseholdId = admin.householdId;

        const p = await prisma.person.create({
            data: { name: 'Cancel Attendee', email: `attendee-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        participantId = p.id;
        householdId = p.householdId;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
    });

    afterEach(async () => {
        await prisma.visit.deleteMany({ where: { personId: participantId } });
        await prisma.rSVP.deleteMany({ where: { personId: participantId } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: participantId } });
        await prisma.rSVP.deleteMany({ where: { personId: participantId } });
        await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { id: { in: [adminId, participantId] } } });
        await prisma.household.deleteMany({ where: { id: { in: [adminHouseholdId, householdId] } } });
    });

    function makeEvent(label: string, startOffsetMs: number, recurringGroupId?: string) {
        const start = new Date(Date.now() + startOffsetMs);
        return prisma.event.create({
            data: {
                name: `${TAG} ${label}`,
                startAt: start,
                endAt: new Date(start.getTime() + HOUR),
                description: 'x',
                ...(recurringGroupId ? { recurringGroupId } : {}),
            },
        });
    }

    // ─── 1. CANCEL ──────────────────────────────────────────────────────────

    describe('cancel — single event', () => {
        it('deletes RSVPs, NULLs visits (does not delete them), and deletes the event', async () => {
            const event = await makeEvent('single-cancel', 2 * HOUR);
            await prisma.rSVP.create({ data: { eventId: event.id, personId: participantId, status: 'ATTENDING' } });
            const visit = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: new Date(), associatedEventId: event.id },
            });

            const res = await patch(event.id, { action: 'cancel' });
            expect(res.status).toBe(200);

            // RSVP gone.
            expect(await prisma.rSVP.findUnique({
                where: { eventId_personId: { eventId: event.id, personId: participantId } },
            })).toBeNull();

            // Visit survives, but its event link is nulled (NOT deleted).
            const survivingVisit = await prisma.visit.findUnique({ where: { id: visit.id } });
            expect(survivingVisit).not.toBeNull();
            expect(survivingVisit!.associatedEventId).toBeNull();

            // Event gone.
            expect(await prisma.event.findUnique({ where: { id: event.id } })).toBeNull();
        });
    });

    describe('cancel — applyToFuture series', () => {
        it('removes only events with start >= the target; PAST events in the series survive', async () => {
            const group = `${TAG}-group`;
            const past = await makeEvent('series-past', -48 * HOUR, group);
            const target = await makeEvent('series-target', 2 * HOUR, group);
            const future = await makeEvent('series-future', 26 * HOUR, group);

            const res = await patch(target.id, { action: 'cancel', applyToFuture: true });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.count).toBe(2); // target + future

            // Past untouched.
            expect(await prisma.event.findUnique({ where: { id: past.id } })).not.toBeNull();
            // Target + future removed.
            expect(await prisma.event.findUnique({ where: { id: target.id } })).toBeNull();
            expect(await prisma.event.findUnique({ where: { id: future.id } })).toBeNull();
        });
    });

    // ─── 2. MANUAL ATTENDANCE × OPEN SCAN VISIT ─────────────────────────────

    describe('manualEditAttendance — Present with an open scan visit', () => {
        it('leaves an open visit already on this event exactly as it is', async () => {
            const event = await makeEvent('manual-present', -1 * HOUR);
            const openArrival = new Date(Date.now() - 90 * MIN);
            const openVisit = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: openArrival, departedAt: null, associatedEventId: event.id },
            });

            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: new Date(Date.now() - 80 * MIN).toISOString(),
                departedAt: new Date(Date.now() - MIN).toISOString(),
            });
            expect(res.status).toBe(200);

            const visits = await prisma.visit.findMany({ where: { personId: participantId } });
            expect(visits).toHaveLength(1);
            expect(visits[0].id).toBe(openVisit.id);
            expect(visits[0].arrivedAt.getTime()).toBe(openArrival.getTime());
            expect(visits[0].departedAt).toBeNull();
        });
    });

    describe('manualEditAttendance — Absent vs open/closed visits', () => {
        // An OPEN visit (departedAt = null) is proof the participant physically
        // scanned in and is still on-site. Marking them Absent must NOT erase it.
        it('rejects Absent on a live (open) check-in and keeps the visit', async () => {
            const event = await makeEvent('manual-absent-open', -1 * HOUR);
            await prisma.visit.create({
                data: { personId: participantId, arrivedAt: new Date(Date.now() - 30 * MIN), departedAt: null, associatedEventId: event.id },
            });

            const res = await patch(event.id, { action: 'manualEditAttendance', participantId, status: 'Absent' });
            expect(res.status).toBe(400);

            const visits = await prisma.visit.findMany({ where: { personId: participantId, associatedEventId: event.id } });
            expect(visits.length).toBe(1); // open visit survives
        });

        it('tombstones a closed (departedAt) visit when marking Absent, and audits it', async () => {
            const event = await makeEvent('manual-absent-closed', -2 * HOUR);
            await prisma.visit.create({
                data: {
                    personId: participantId,
                    arrivedAt: new Date(Date.now() - 90 * MIN),
                    departedAt: new Date(Date.now() - 60 * MIN),
                    associatedEventId: event.id,
                },
            });

            const res = await patch(event.id, { action: 'manualEditAttendance', participantId, status: 'Absent' });
            expect(res.status).toBe(200);

            // A lead's Absent mark is as reversible as the member's own delete: the row
            // survives with deletedAt set, and drops out of every LIVE_VISIT read.
            const visits = await prisma.visit.findMany({ where: { personId: participantId, associatedEventId: event.id } });
            expect(visits.length).toBe(1);
            expect(visits[0].deletedAt).not.toBeNull();
            expect(visits[0].deletedById).toBe(adminId);
            expect(await prisma.visit.count({
                where: { personId: participantId, associatedEventId: event.id, deletedAt: null },
            })).toBe(0);

            const audit = await prisma.auditLog.findFirst({
                where: { tableName: 'Visit', affectedEntityId: visits[0].id, action: 'DELETE' },
            });
            expect(audit).not.toBeNull();
            expect(audit!.actorId).toBe(adminId);
            expect(audit!.secondaryAffectedEntity).toBe(participantId);

            // 30-minute visit, untagged sources (weight 1), doubled for proxy
            // (admin != participant): 30 * 1 * 2 = 60. Always flagged (delete floor).
            expect((audit!.newData as { significance?: { score: number; flagged: boolean } })?.significance)
                .toEqual({ score: 60, flagged: true });
        });

        it('rejects and deletes nothing when an open visit coexists with a closed one', async () => {
            const event = await makeEvent('manual-absent-mix', -2 * HOUR);
            await prisma.visit.create({
                data: {
                    personId: participantId,
                    arrivedAt: new Date(Date.now() - 110 * MIN),
                    departedAt: new Date(Date.now() - 80 * MIN),
                    associatedEventId: event.id,
                },
            });
            await prisma.visit.create({
                data: { personId: participantId, arrivedAt: new Date(Date.now() - 30 * MIN), departedAt: null, associatedEventId: event.id },
            });

            const res = await patch(event.id, { action: 'manualEditAttendance', participantId, status: 'Absent' });
            expect(res.status).toBe(400);

            // All-or-nothing: the open visit blocks the edit, so the closed one stays too.
            const visits = await prisma.visit.findMany({ where: { personId: participantId, associatedEventId: event.id } });
            expect(visits.length).toBe(2);
        });
    });

    // ─── 2b. PRESENT vs AN OPEN VISIT THIS EVENT DOESN'T OWN ────────────────

    describe('manualEditAttendance — a Present mark records attendance', () => {
        const mark = (eventId: number, arrivedAt: Date, departedAt: Date | null) => patch(eventId, {
            action: 'manualEditAttendance',
            participantId,
            status: 'Present',
            arrivedAt: arrivedAt.toISOString(),
            departedAt: departedAt ? departedAt.toISOString() : null,
        });
        const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

        it('links an open kiosk visit covering the session and never departs it', async () => {
            const event = await makeEvent('link-open', -1 * HOUR);
            const walkIn = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: ago(90), arrivedVia: 'SCANNER' },
            });

            const res = await mark(event.id, ago(50), ago(5));
            expect(res.status).toBe(200);

            const visits = await prisma.visit.findMany({ where: { personId: participantId } });
            expect(visits).toHaveLength(1);
            expect(visits[0].id).toBe(walkIn.id);
            expect(visits[0].associatedEventId).toBe(event.id);
            expect(visits[0].departedAt).toBeNull();
            expect(visits[0].arrivedAt.getTime()).toBe(walkIn.arrivedAt.getTime());
            expect(visits[0].arrivedVia).toBe('SCANNER');
        });

        it('links a closed kiosk visit covering the session, keeping its times', async () => {
            const event = await makeEvent('link-closed', -1 * HOUR);
            const kiosk = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: ago(70), departedAt: ago(10), arrivedVia: 'SCANNER', departedVia: 'SCANNER' },
            });

            const res = await mark(event.id, ago(60), ago(5));
            expect(res.status).toBe(200);

            const visits = await prisma.visit.findMany({ where: { personId: participantId } });
            expect(visits).toHaveLength(1);
            expect(visits[0].associatedEventId).toBe(event.id);
            expect(visits[0].departedAt!.getTime()).toBe(kiosk.departedAt!.getTime());
        });

        it('creates a closed visit when no kiosk visit covers the session', async () => {
            const event = await makeEvent('create-closed', -1 * HOUR);
            const res = await mark(event.id, ago(60), ago(5));
            expect(res.status).toBe(200);

            const visit = await prisma.visit.findFirstOrThrow({ where: { personId: participantId } });
            expect(visit.associatedEventId).toBe(event.id);
            expect(visit.departedAt).not.toBeNull();
        });

        it('refuses a mark with no departure, writing nothing', async () => {
            const event = await makeEvent('no-departure', -1 * HOUR);
            const res = await mark(event.id, ago(50), null);
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/departure/i);
            expect(await prisma.visit.count({ where: { personId: participantId } })).toBe(0);
        });

        it('refuses a mark before the session starts, writing nothing', async () => {
            const event = await makeEvent('not-started', 1 * HOUR);
            const res = await mark(event.id, ago(50), ago(5));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/session has started/i);
            expect(await prisma.visit.count({ where: { personId: participantId } })).toBe(0);
        });

        it('refuses when the overlapping open visit belongs to another event', async () => {
            const other = await makeEvent('open-other', -3 * HOUR);
            const event = await makeEvent('open-target', -1 * HOUR);
            const openElsewhere = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: ago(150), associatedEventId: other.id },
            });

            const res = await mark(event.id, ago(50), ago(5));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/checked in from/i);

            const visits = await prisma.visit.findMany({ where: { personId: participantId } });
            expect(visits).toHaveLength(1);
            expect(visits[0].id).toBe(openElsewhere.id);
            expect(visits[0].associatedEventId).toBe(other.id);
        });

        it('applies and flags a mark that overlaps a closed visit, naming it', async () => {
            const event = await makeEvent('flag-closed', -1 * HOUR);
            const typed = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: ago(70), departedAt: ago(30), arrivedVia: 'TYPED', departedVia: 'TYPED' },
            });

            const res = await mark(event.id, ago(60), ago(5));
            expect(res.status).toBe(200);

            const created = await prisma.visit.findFirstOrThrow({ where: { personId: participantId, associatedEventId: event.id } });
            expect(created.id).not.toBe(typed.id);
            const audit = await prisma.auditLog.findFirstOrThrow({
                where: { tableName: 'Visit', affectedEntityId: created.id, action: 'CREATE' },
            });
            expect(audit.newData).toMatchObject({ significance: { flagged: true }, overlapsVisitIds: [typed.id] });
        });

        it('refuses a mark with no departure on a closed visit, keeping its departure', async () => {
            const event = await makeEvent('keep-closed', -9 * HOUR);
            const closed = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: ago(480), departedAt: ago(60), associatedEventId: event.id },
            });
            const res = await mark(event.id, closed.arrivedAt, null);
            expect(res.status).toBe(400);
            const after = await prisma.visit.findUniqueOrThrow({ where: { id: closed.id } });
            expect(after.departedAt!.getTime()).toBe(closed.departedAt!.getTime());
        });
    });

    // ─── 2c. VISIT SOURCE ON A ROSTER MARK ──────────────────────────────────

    // arrivedVia is how the arrival was MEASURED. A visit this mark creates is
    // LEAD_MARKED; an edited visit keeps its measured source UNLESS
    // the lead moves the arrival time, which restamps it to TYPED (a corrected
    // time is a typed clock). Stamping it unconditionally would relabel a real
    // badge-in on a departure-only edit, downgrading the trust weight that
    // correction significance reads for the people who did scan in.
    describe('manualEditAttendance — arrivedVia/departedVia', () => {
        it('stamps LEAD_MARKED on both fields of a visit it creates', async () => {
            const event = await makeEvent('source-create', -3 * HOUR);
            const arrival = new Date(Date.now() - 150 * MIN);
            const departure = new Date(Date.now() - 30 * MIN);

            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: arrival.toISOString(),
                departedAt: departure.toISOString(),
            });
            expect(res.status).toBe(200);

            const visit = await prisma.visit.findFirstOrThrow({ where: { personId: participantId, associatedEventId: event.id } });
            expect(visit.arrivedVia).toBe('LEAD_MARKED');
            expect(visit.departedVia).toBe('LEAD_MARKED');

            const audit = await prisma.auditLog.findFirstOrThrow({
                where: { tableName: 'Visit', affectedEntityId: visit.id, action: 'CREATE' },
            });
            expect(audit.newData).toMatchObject({ arrivedVia: 'LEAD_MARKED', departedVia: 'LEAD_MARKED' });
        });

        it('keeps the arrival source but stamps the departure a lead types on a closed visit', async () => {
            const event = await makeEvent('source-edit-existing', -4 * HOUR);
            const existing = await prisma.visit.create({
                data: {
                    personId: participantId, arrivedAt: new Date(Date.now() - 200 * MIN),
                    departedAt: new Date(Date.now() - 90 * MIN), associatedEventId: event.id, arrivedVia: 'SCANNER', departedVia: 'SCANNER',
                },
            });

            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: existing.arrivedAt.toISOString(),
                departedAt: new Date(Date.now() - 60 * MIN).toISOString(),
            });
            expect(res.status).toBe(200);

            const after = await prisma.visit.findUniqueOrThrow({ where: { id: existing.id } });
            expect(after.arrivedVia).toBe('SCANNER');
            expect(after.departedVia).toBe('LEAD_MARKED');
        });

        it('restamps a closed visit to TYPED when the lead moves its arrival', async () => {
            const event = await makeEvent('source-corrected', -4 * HOUR);
            const existing = await prisma.visit.create({
                data: {
                    personId: participantId, arrivedAt: new Date(Date.now() - 200 * MIN),
                    departedAt: new Date(Date.now() - 90 * MIN), associatedEventId: event.id, arrivedVia: 'SCANNER', departedVia: 'SCANNER',
                },
            });

            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: new Date(Date.now() - 180 * MIN).toISOString(),
                departedAt: existing.departedAt!.toISOString(),
            });
            expect(res.status).toBe(200);

            const after = await prisma.visit.findUniqueOrThrow({ where: { id: existing.id } });
            expect(after.arrivedVia).toBe('TYPED');
        });
    });

    // ─── 3. PAST-EVENT GUARD ────────────────────────────────────────────────

    describe('past-event editTime — rejected', () => {
        // Editing a finished event is blocked (400) before any write.
        it('rejects the edit and leaves the event start untouched', async () => {
            const event = await makeEvent('past-edit', -2 * HOUR);

            const newStart = new Date(Date.now() - 90 * MIN);
            const res = await patch(event.id, { action: 'editTime', startAt: newStart.toISOString() });
            expect(res.status).toBe(400);

            // Guard fires before any write → event start unchanged.
            const after = await prisma.event.findUnique({ where: { id: event.id } });
            expect(after!.startAt.getTime()).toBe(event.startAt.getTime());
        });
    });
});
