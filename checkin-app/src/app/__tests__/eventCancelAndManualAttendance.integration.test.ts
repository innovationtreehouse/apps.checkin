/**
 * @jest-environment node
 */
/**
 * Integration tests for three write paths in PATCH /api/events/[id] that can
 * corrupt attendance / safety data:
 *
 *   1. CANCEL (single + recurring series) — transactional; visits NULLed, not deleted.
 *   2. manualEditAttendance vs. an OPEN scan visit (Present update / Absent reject).
 *   3. PAST-EVENT edit guard (editTime on a finished event is rejected).
 *
 * BUG 2 (manual "Absent" deleting a live/open check-in) is now FIXED: an Absent
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
        it('UPDATES the existing open visit instead of creating a second one', async () => {
            const event = await makeEvent('manual-present', -1 * HOUR);
            const openArrival = new Date(Date.now() - 90 * MIN);
            const openVisit = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: openArrival, departedAt: null, associatedEventId: event.id },
            });

            const newArrival = new Date(Date.now() - 80 * MIN);
            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: newArrival.toISOString(),
            });
            expect(res.status).toBe(200);

            const visits = await prisma.visit.findMany({ where: { personId: participantId, associatedEventId: event.id } });
            expect(visits.length).toBe(1);               // not a second visit
            expect(visits[0].id).toBe(openVisit.id);     // same row, updated in place
            expect(visits[0].arrivedAt.getTime()).toBe(newArrival.getTime());

            // 10-minute arrival shift on an untagged (weight 1) visit, doubled
            // for proxy (admin != participant): 10 * 1 * 2 = 20, under the
            // 90-point flag threshold.
            const audit = await prisma.auditLog.findFirst({
                where: { tableName: 'Visit', affectedEntityId: openVisit.id, action: 'EDIT' },
            });
            expect((audit?.newData as { significance?: { score: number; flagged: boolean } })?.significance)
                .toEqual({ score: 20, flagged: false });
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

            // A lead's Absent mark is as reversible as the member's own delete
            // (AT3 §3): the row survives with deletedAt set, and drops out of
            // every LIVE_VISIT read.
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

    describe('manualEditAttendance — Present while an open visit exists elsewhere', () => {
        it('adopts an unassociated open visit into the event instead of failing the one-open-visit index', async () => {
            const event = await makeEvent('manual-present-walkin', -1 * HOUR);
            // Ordinary walk-in badge-in: open, not tied to any event.
            const walkIn = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: new Date(Date.now() - 90 * MIN), departedAt: null, associatedEventId: null },
            });

            const newArrival = new Date(Date.now() - 80 * MIN);
            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: newArrival.toISOString(),
                departedAt: null,
            });
            expect(res.status).toBe(200);

            const visits = await prisma.visit.findMany({ where: { personId: participantId } });
            expect(visits.length).toBe(1);              // no second visit written
            expect(visits[0].id).toBe(walkIn.id);       // the walk-in row itself
            expect(visits[0].associatedEventId).toBe(event.id);
            expect(visits[0].departedAt).toBeNull();    // still on-site
            expect(visits[0].arrivedAt.getTime()).toBe(newArrival.getTime());
        });

        it('rejects with an actionable 400 when the open visit belongs to another event', async () => {
            const other = await makeEvent('manual-present-other', -3 * HOUR);
            const event = await makeEvent('manual-present-target', -1 * HOUR);
            const openElsewhere = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: new Date(Date.now() - 150 * MIN), departedAt: null, associatedEventId: other.id },
            });

            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: new Date(Date.now() - 50 * MIN).toISOString(),
                departedAt: null,
            });
            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toMatch(/checked in/i);

            // Nothing written: the other event keeps its open visit.
            const visits = await prisma.visit.findMany({ where: { personId: participantId } });
            expect(visits.length).toBe(1);
            expect(visits[0].id).toBe(openElsewhere.id);
            expect(visits[0].associatedEventId).toBe(other.id);
        });

        it('closes the open walk-in in place when a departure time is supplied', async () => {
            const event = await makeEvent('manual-present-close-walkin', -2 * HOUR);
            const walkIn = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: new Date(Date.now() - 150 * MIN), departedAt: null, associatedEventId: null },
            });

            const arrival = new Date(Date.now() - 140 * MIN);
            const departure = new Date(Date.now() - 60 * MIN);
            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: arrival.toISOString(),
                departedAt: departure.toISOString(),
            });
            expect(res.status).toBe(200);

            // A closed result can't collide with the index, so the walk-in is left
            // alone and this event gets its own closed record.
            const visits = await prisma.visit.findMany({ where: { personId: participantId }, orderBy: { id: 'asc' } });
            expect(visits.length).toBe(2);
            expect(visits.find(v => v.id === walkIn.id)!.departedAt).toBeNull();
            const forEvent = visits.find(v => v.associatedEventId === event.id)!;
            expect(forEvent.departedAt!.getTime()).toBe(departure.getTime());
        });

        // "No reopening a closed visit" is a route-level validity rule
        // (1256 §2) that facility/visits PATCH enforces. A Present mark with no
        // departure against a closed visit would null it, destroying a recorded
        // departure — the single most damaging edit this surface can make.
        it('refuses to reopen a closed visit, leaving its departure and writing no audit row', async () => {
            const event = await makeEvent('manual-present-no-reopen', -9 * HOUR);
            const arrival = new Date(Date.now() - 8 * HOUR);
            const departure = new Date(Date.now() - 1 * HOUR);
            const closed = await prisma.visit.create({
                data: { personId: participantId, arrivedAt: arrival, departedAt: departure, associatedEventId: event.id },
            });

            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: arrival.toISOString(),
            });
            expect(res.status).toBe(400);

            const after = await prisma.visit.findUniqueOrThrow({ where: { id: closed.id } });
            expect(after.departedAt!.getTime()).toBe(departure.getTime());

            const audits = await prisma.auditLog.findMany({
                where: { tableName: 'Visit', affectedEntityId: closed.id },
            });
            expect(audits).toHaveLength(0);
        });
    });

    // ─── 2c. VISIT SOURCE ON A ROSTER MARK ──────────────────────────────────

    // arrivedVia is how the arrival was MEASURED. A visit this mark creates is
    // LEAD_MARKED; an adopted or edited visit keeps its measured source UNLESS
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

        it('leaves an adopted walk-in on its measured SCANNER arrival when the time is unchanged', async () => {
            const event = await makeEvent('source-adopt', -1 * HOUR);
            const walkIn = await prisma.visit.create({
                data: {
                    personId: participantId, arrivedAt: new Date(Date.now() - 90 * MIN),
                    departedAt: null, associatedEventId: null, arrivedVia: 'SCANNER',
                },
            });

            // Pure adoption: same arrival time, so the source is not restamped.
            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: walkIn.arrivedAt.toISOString(),
                departedAt: null,
            });
            expect(res.status).toBe(200);

            const after = await prisma.visit.findUniqueOrThrow({ where: { id: walkIn.id } });
            expect(after.associatedEventId).toBe(event.id); // adopted
            expect(after.arrivedVia).toBe('SCANNER');       // still a measured arrival
            expect(after.departedVia).toBeNull();           // no departure supplied

            // The audit must not claim a field it did not write.
            const audit = await prisma.auditLog.findFirstOrThrow({
                where: { tableName: 'Visit', affectedEntityId: walkIn.id, action: 'EDIT' },
            });
            expect(audit.newData).not.toHaveProperty('arrivedVia');
        });

        it('restamps an adopted walk-in to TYPED when the lead moves its arrival', async () => {
            const event = await makeEvent('source-adopt-corrected', -1 * HOUR);
            const walkIn = await prisma.visit.create({
                data: {
                    personId: participantId, arrivedAt: new Date(Date.now() - 90 * MIN),
                    departedAt: null, associatedEventId: null, arrivedVia: 'SCANNER',
                },
            });

            // Adoption AND an arrival correction: the moved time is now a typed clock.
            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: new Date(Date.now() - 80 * MIN).toISOString(),
                departedAt: null,
            });
            expect(res.status).toBe(200);

            const after = await prisma.visit.findUniqueOrThrow({ where: { id: walkIn.id } });
            expect(after.associatedEventId).toBe(event.id); // adopted
            expect(after.arrivedVia).toBe('TYPED');         // arrival moved → typed clock
        });

        it('keeps the arrival source but stamps the departure a lead types on an existing visit', async () => {
            const event = await makeEvent('source-edit-existing', -4 * HOUR);
            const existing = await prisma.visit.create({
                data: {
                    personId: participantId, arrivedAt: new Date(Date.now() - 200 * MIN),
                    departedAt: null, associatedEventId: event.id, arrivedVia: 'SCANNER',
                },
            });

            // Only the departure is added; the arrival time is resent unchanged,
            // so its measured source survives.
            const res = await patch(event.id, {
                action: 'manualEditAttendance',
                participantId,
                status: 'Present',
                arrivedAt: existing.arrivedAt.toISOString(),
                departedAt: new Date(Date.now() - 60 * MIN).toISOString(),
            });
            expect(res.status).toBe(200);

            const after = await prisma.visit.findUniqueOrThrow({ where: { id: existing.id } });
            expect(after.arrivedVia).toBe('SCANNER');        // not overwritten
            expect(after.departedVia).toBe('LEAD_MARKED');   // the lead asserted this
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
