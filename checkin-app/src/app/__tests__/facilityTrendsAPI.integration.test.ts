/**
 * @jest-environment node
 */
/**
 * Integration tests for GET /api/facility/trends.
 *
 * 401/403 (roles: isSysadmin, isBoardMember) are already covered by
 * authzRoleRejection.integration.test.ts — this file focuses on the success
 * path: bucketing visits by period, the volunteer/participant split (by program
 * enrollment — ProgramParticipant, NOT age), structured (event-associated) vs
 * unstructured hours, and source-independence: every completed visit counts
 * whatever recorded it — SCANNER, WEB, LEAD_MARKED, the legacy `SYSTEM`
 * spelling, or nothing at all. The only exclusions left are structural — an
 * open visit (no duration), a soft-deleted one, and anything outside the
 * lookback window — plus the `programId` filter and the invalid-period 400.
 * Corrections and a staff walk-in insert are driven through the real routes,
 * since a hand-built fixture cannot catch a wrong `arrivedVia` stamp; the stamp
 * still matters because correction significance is weighted by source, which
 * deleting that inserted walk-in pins at the LEAD_MARKED weight.
 */

import { GET } from '@/app/api/facility/trends/route';
import { PATCH, DELETE as VISITS_DELETE } from '@/app/api/facility/visits/route';
import { PATCH as MANUAL_PATCH } from '@/app/api/attendance/manual/[id]/route';
import { POST as INSERT_POST } from '@/app/api/facility/visits/insert/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { getAppSettings } from '@/lib/appSettings';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'facility-trends-test';

describe('Facility trends API', () => {
    let adminId: number;
    let householdId: number;
    let volunteerId: number; // adult, not enrolled -> volunteer
    let enrolledAdultId: number; // adult, ACTIVE ProgramParticipant -> participant (proves age doesn't drive it)
    let youthId: number; // youth by DOB, not enrolled -> volunteer (proves age doesn't drive it)
    let programId: number;
    let otherProgramId: number;
    let untaggedProgramId: number;
    let eventId: number;
    let untaggedEventId: number;
    const visitIds: number[] = [];

    // Every seeded arrival hangs off one anchor, a few minutes apart and at least an hour
    // into the month, so the whole seed lands in a single calendar-month bucket no matter
    // when the suite runs. The route buckets on arrivedAt only, so departures that spill
    // past midnight into the next month are fine.
    //
    // The month the anchor sits in is the ORG timezone's, since that is what the route
    // buckets against — resolved in beforeAll because the zone comes from AppSettings.
    let ANCHOR: Date;
    // The bucket the assertions inspect, keyed the way the route keys it (org-zone month start).
    let BUCKET_START: Date;
    const arrival = (minutesBefore: number) => new Date(ANCHOR.getTime() - minutesBefore * 60 * 1000);
    const departure = (minutesBefore: number, hours: number) =>
        new Date(arrival(minutesBefore).getTime() + hours * 60 * 60 * 1000);

    beforeAll(async () => {
        const { timezone } = await getAppSettings();
        const monthStart = (d: Date) => {
            const z = toZonedTime(d, timezone);
            z.setDate(1);
            z.setHours(0, 0, 0, 0);
            return fromZonedTime(z, timezone);
        };
        const NOW = new Date();
        ANCHOR = new Date(Math.max(NOW.getTime(), monthStart(NOW).getTime() + 60 * 60 * 1000));
        BUCKET_START = monthStart(ANCHOR);

        const admin = await prisma.person.create({
            data: { email: `admin-${TAG}@example.com`, name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } },
        });
        adminId = admin.id;
        householdId = admin.householdId;

        const volunteer = await prisma.person.create({
            data: { email: `volunteer-${TAG}@example.com`, name: 'Volunteer', dateOfBirth: new Date('1980-01-01'), householdId },
        });
        volunteerId = volunteer.id;
        const enrolledAdult = await prisma.person.create({
            data: { email: `enrolled-${TAG}@example.com`, name: 'Enrolled Adult', dateOfBirth: new Date('1985-01-01'), householdId },
        });
        enrolledAdultId = enrolledAdult.id;
        const youth = await prisma.person.create({
            data: { email: `youth-${TAG}@example.com`, name: 'Youth', dateOfBirth: new Date('2015-01-01'), householdId },
        });
        youthId = youth.id;

        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Prog ${TAG}` } });
        programId = program.id;
        const otherProgram = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Other ${TAG}` } });
        otherProgramId = otherProgram.id;
        const event = await prisma.event.create({
            data: { programId, name: `Event ${TAG}`, startAt: arrival(2), endAt: departure(2, 3) },
        });
        eventId = event.id;

        // Enroll the adult in `programId` (ACTIVE) — this, not their age, makes them a participant.
        await prisma.programParticipant.create({
            data: { programId, personId: enrolledAdultId, status: 'ACTIVE' },
        });

        // Structured visit (associated to the event): enrolled adult, 3 hours -> participant.
        const structured = await prisma.visit.create({
            data: { personId: enrolledAdultId, arrivedAt: arrival(2), departedAt: departure(2, 3), arrivedVia: 'SCANNER', associatedEventId: eventId },
        });
        // Structured visit (associated to the event): non-enrolled youth, 2 hours -> volunteer.
        const youthStructured = await prisma.visit.create({
            data: { personId: youthId, arrivedAt: arrival(2), departedAt: departure(2, 2), arrivedVia: 'SCANNER', associatedEventId: eventId },
        });
        // Unstructured visit (no event): non-enrolled adult volunteer, 1 hour.
        const unstructured = await prisma.visit.create({
            data: { personId: volunteerId, arrivedAt: arrival(1), departedAt: departure(1, 1), arrivedVia: 'WEB' },
        });
        // Staff-asserted "marked present" visit (arrivedVia LEAD_MARKED): a
        // completed visit like any other, 3h that counts.
        const synthetic = await prisma.visit.create({
            data: { personId: volunteerId, arrivedAt: arrival(2), departedAt: departure(2, 3), arrivedVia: 'LEAD_MARKED', associatedEventId: eventId },
        });
        // The same thing in its pre-split spelling. A rolling deploy's drain window
        // lets the previous release keep writing SYSTEM — 3h, counted the same.
        const legacySynthetic = await prisma.visit.create({
            data: { personId: volunteerId, arrivedAt: arrival(3), departedAt: departure(3, 3), arrivedVia: 'SYSTEM', associatedEventId: eventId },
        });
        // Still-open visit (no departedAt) — excluded (departedAt: { not: null } in the where).
        const open = await prisma.visit.create({
            data: { personId: youthId, arrivedAt: arrival(0), arrivedVia: 'WEB' },
        });
        // A program of its own, so the source-independence and structural-exclusion
        // assertions can scope by programId and be exact instead of leaning on the
        // shared month bucket. Four visits hang off it, one per person so that any
        // one of them leaking into the totals is individually visible.
        const untaggedProgram = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Untagged ${TAG}` } });
        untaggedProgramId = untaggedProgram.id;
        const untaggedEvent = await prisma.event.create({
            data: { programId: untaggedProgramId, name: `Untagged event ${TAG}`, startAt: arrival(2), endAt: departure(2, 3) },
        });
        untaggedEventId = untaggedEvent.id;
        // Arrival with no source recorded: an ordinary visit, 2h, counted.
        const untagged = await prisma.visit.create({
            data: { personId: volunteerId, arrivedAt: arrival(2), departedAt: departure(2, 2), arrivedVia: null, associatedEventId: untaggedEventId },
        });
        // Staff-asserted arrival in the same program, 3h, counted the same.
        const untaggedProgramSynthetic = await prisma.visit.create({
            data: { personId: youthId, arrivedAt: arrival(2), departedAt: departure(2, 3), arrivedVia: 'LEAD_MARKED', associatedEventId: untaggedEventId },
        });
        // Still-open visit (no departedAt) — excluded by `departedAt: { not: null }`.
        // Its person appears nowhere else in this program, so admitting it would
        // show up as an extra unique volunteer even though it adds 0 hours.
        const openUntagged = await prisma.visit.create({
            data: { personId: enrolledAdultId, arrivedAt: arrival(0), arrivedVia: 'WEB', associatedEventId: untaggedEventId },
        });
        // Soft-deleted visit — excluded by `deletedAt: null`. A conspicuous 7h so
        // that admitting it is unmistakable in the totals.
        const softDeleted = await prisma.visit.create({
            data: { personId: adminId, arrivedAt: arrival(4), departedAt: departure(4, 7), arrivedVia: 'SCANNER', associatedEventId: untaggedEventId, deletedAt: new Date() },
        });

        visitIds.push(structured.id, youthStructured.id, unstructured.id, synthetic.id, legacySynthetic.id, open.id,
            untagged.id, untaggedProgramSynthetic.id, openUntagged.id, softDeleted.id);
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { id: { in: visitIds } } });
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.programVolunteer.deleteMany({ where: { personId: { in: [adminId, volunteerId, enrolledAdultId, youthId] } } });
        await prisma.event.deleteMany({ where: { id: { in: [eventId, untaggedEventId] } } });
        await prisma.program.deleteMany({ where: { id: { in: [programId, otherProgramId, untaggedProgramId] } } });
        await prisma.person.deleteMany({ where: { id: { in: [adminId, volunteerId, enrolledAdultId, youthId] } } });
        await prisma.household.deleteMany({ where: { id: householdId } });
    });

    const callAs = async (user: object | null, query = '') => {
        (getServerSession as jest.Mock).mockResolvedValue(user === null ? null : { user });
        const req = new Request(`http://localhost:4000/api/facility/trends${query}`, { method: 'GET' });
        return GET(req as unknown as import('next/server').NextRequest);
    };

    it('rejects an invalid period with 400', async () => {
        const res = await callAs({ id: adminId, isSysadmin: true }, '?period=fortnight');
        expect(res.status).toBe(400);
    });

    it('buckets visits, splitting volunteer/participant and structured/unstructured hours', async () => {
        const res = await callAs({ id: adminId, isSysadmin: true }, '?period=month');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.period).toBe('month');
        expect(Array.isArray(data.buckets)).toBe(true);

        // Look the anchor's bucket up by periodStart: the seed's month is not necessarily
        // the last bucket, since any unrelated visit in a later month adds one.
        expect(data.buckets.map((b: { periodStart: string }) => b.periodStart)).toContain(BUCKET_START.toISOString());
        const thisMonth = data.buckets.find((b: { periodStart: string }) => b.periodStart === BUCKET_START.toISOString());
        expect(thisMonth.uniqueVolunteers).toBeGreaterThanOrEqual(1);
        expect(thisMonth.uniqueParticipants).toBeGreaterThanOrEqual(1);
        // Structured (event-associated) = the 3h enrolled-adult + 2h youth visits, plus the
        // staff-asserted and legacy-SYSTEM ones; unstructured = the 1h volunteer visit.
        // Still-open and soft-deleted visits are excluded.
        expect(thisMonth.structuredHours).toBeGreaterThanOrEqual(5);
        expect(thisMonth.unstructuredHours).toBeGreaterThanOrEqual(1);
        expect(data.totals.label).toBe('Total');
    });

    it('splits by program enrollment, not age', async () => {
        // Scope to `programId` so only this test's event-associated visits are counted
        // (deterministic — otherProgramId/global data can't leak in). Four visits qualify:
        // the enrolled adult (3h SCANNER), the non-enrolled youth (2h SCANNER), and the
        // volunteer's staff-asserted (3h) and legacy-SYSTEM (3h) visits.
        const res = await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${programId}`);
        expect(res.status).toBe(200);
        const data = await res.json();

        // Enrolled ADULT counts as a participant — age (35+) does not demote them.
        expect(data.totals.uniqueParticipants).toBe(1);
        expect(data.totals.totalParticipantHours).toBe(3);
        // Non-enrolled YOUTH counts as a volunteer — age (<18) does not make them a participant.
        expect(data.totals.uniqueVolunteers).toBe(2);
        expect(data.totals.totalVolunteerHours).toBe(8);
    });

    // Issue #1676: bySource decomposes HOURS by arrivedVia, never people. This
    // program's bucket is the case that matters — `volunteerId` carries both a
    // LEAD_MARKED (3h) and a SYSTEM (3h) visit here, so a per-source person count
    // would double-count them, but uniqueVolunteers must not.
    it('decomposes hours by source without decomposing unique-person counts', async () => {
        const res = await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${programId}`);
        expect(res.status).toBe(200);
        const data = await res.json();

        // SCANNER: enrolled adult (3h, participant) + youth (2h, volunteer).
        // LEAD_MARKED and SYSTEM: volunteerId's two visits, 3h each.
        expect(data.totals.bySource).toEqual({ SCANNER: 5, LEAD_MARKED: 3, SYSTEM: 3 });

        const bySourceSum = Object.values(data.totals.bySource as Record<string, number>)
            .reduce((sum: number, hours: number) => sum + hours, 0);
        expect(bySourceSum).toBeCloseTo(data.totals.totalVolunteerHours + data.totals.totalParticipantHours, 5);

        // volunteerId is still ONE unique volunteer, not one per source.
        expect(data.totals.uniqueVolunteers).toBe(2); // youthId + volunteerId
        expect(data.totals).not.toHaveProperty('uniqueVolunteersBySource');
        expect(data.totals).not.toHaveProperty('uniqueParticipantsBySource');
    });

    // Source records how an arrival was measured; it does not decide whether the
    // visit is facility time. An untagged arrival, a scanned one, a staff roster
    // mark and the legacy SYSTEM spelling all sum the same way.
    it('counts every source alike — untagged, staff-marked and legacy SYSTEM', async () => {
        const res = await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${untaggedProgramId}`);
        expect(res.status).toBe(200);
        const data = await res.json();

        // The 2h untagged visit AND the 3h LEAD_MARKED one in the same program.
        expect(data.totals.uniqueVolunteers).toBe(2);
        expect(data.totals.totalVolunteerHours).toBe(5);
        expect(data.totals.uniqueParticipants).toBe(0);
        expect(data.totals.structuredHours).toBe(5);

        // The legacy SYSTEM spelling hangs off `programId`'s event: 3h of the 8
        // volunteer hours there, alongside the 3h LEAD_MARKED and 2h SCANNER ones.
        const legacy = await (await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${programId}`)).json();
        expect(legacy.totals.totalVolunteerHours).toBe(8);
    });

    // What the route still excludes, now that source no longer gates anything:
    // an open visit has no duration to sum, and a deleted visit did not happen.
    it('still excludes open and soft-deleted visits', async () => {
        const res = await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${untaggedProgramId}`);
        expect(res.status).toBe(200);
        const data = await res.json();

        // Both hang off the same event as the two counted visits, each on a person
        // who appears nowhere else in this program — so admitting the open one would
        // read as a third unique volunteer, and the deleted one as 7 extra hours.
        expect(data.totals.uniqueVolunteers).toBe(2);
        expect(data.totals.totalVolunteerHours).toBe(5);
        // The deleted row is still there: it is filtered out, not missing.
        expect(await prisma.visit.count({ where: { associatedEventId: untaggedEventId, deletedAt: { not: null } } })).toBe(1);
    });

    // Driven through the PATCH route on purpose. Every other case here builds its
    // `arrivedVia` by hand, so both the correct behaviour and the broken one pass
    // them — only calling the real correction path can catch a wrong stamp.
    //
    // A board member fixing a badge time re-times the visit; it never removes it,
    // and the corrected duration is what the hours show.
    it('keeps a corrected scanner visit in the hours after a staff PATCH', async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Corrected ${TAG}` } });
        const event = await prisma.event.create({
            data: { programId: program.id, name: `Corrected event ${TAG}`, startAt: arrival(2), endAt: departure(2, 3) },
        });
        // Both ends in the past: the PATCH route rejects a future time, and the
        // shared `departure()` helper lands hours ahead of now.
        const now = Date.now();
        const visit = await prisma.visit.create({
            data: {
                personId: volunteerId,
                arrivedAt: new Date(now - 4 * 3600000),
                departedAt: new Date(now - 2 * 3600000),
                arrivedVia: 'SCANNER',
                departedVia: 'SCANNER',
                associatedEventId: event.id,
            },
        });
        visitIds.push(visit.id);

        const before = await (await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${program.id}`)).json();
        expect(before.totals.totalVolunteerHours).toBe(2);

        // The board fixes the arrival: the member badged in an hour later than recorded.
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
        const patch = await PATCH(new Request('http://localhost:4000/api/facility/visits', {
            method: 'PATCH',
            body: JSON.stringify({ visitId: visit.id, arrivedAt: new Date(now - 3 * 3600000).toISOString() }),
        }) as unknown as import('next/server').NextRequest);
        expect(patch.status).toBe(200);

        // Still counted, now at the corrected 1h.
        const after = await (await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${program.id}`)).json();
        expect(after.totals.uniqueVolunteers).toBe(1);
        expect(after.totals.totalVolunteerHours).toBe(1);
        expect(after.totals.structuredHours).toBe(1);

        await prisma.auditLog.deleteMany({ where: { tableName: 'Visit', affectedEntityId: visit.id } });
        await prisma.visit.delete({ where: { id: visit.id } });
        await prisma.event.delete({ where: { id: event.id } });
        await prisma.program.delete({ where: { id: program.id } });
    });

    // #1624: staff walk-in insert stamps TYPED (typed clocks, actor on the
    // audit row). Hours count either way; the stamp is what must not regress
    // to WEB or LEAD_MARKED (window, no clock).
    it('counts a real staff walk-in insert in trends hours', async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `StaffEntry ${TAG}` } });
        const insertArrival = new Date(Date.now() - 4 * 3600000);
        const insertDeparture = new Date(Date.now() - 2 * 3600000);
        const event = await prisma.event.create({
            data: {
                programId: program.id,
                name: `StaffEntry event ${TAG}`,
                startAt: new Date(insertArrival.getTime() - 3600000),
                endAt: new Date(insertDeparture.getTime() + 3600000),
            },
        });
        await prisma.programVolunteer.create({ data: { programId: program.id, personId: volunteerId } });

        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
        const insertRes = await INSERT_POST(new Request('http://localhost:4000/api/facility/visits/insert', {
            method: 'POST',
            body: JSON.stringify({
                personId: volunteerId,
                arrivedAt: insertArrival.toISOString(),
                departedAt: insertDeparture.toISOString(),
            }),
        }) as unknown as import('next/server').NextRequest);
        expect(insertRes.status).toBe(200);
        const { visit } = await insertRes.json();
        visitIds.push(visit.id);
        expect(visit.arrivedVia).toBe('TYPED');

        const res = await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${program.id}`);
        const data = await res.json();
        // Counted like any other completed visit: the inserted 2h walk-in, on one
        // volunteer, event-associated by the route so all of it is structured.
        expect(data.totals.uniqueVolunteers).toBe(1);
        expect(data.totals.totalVolunteerHours).toBe(2);
        expect(data.totals.structuredHours).toBe(2);

        // Delete of a TYPED walk-in: 120 minutes * weight 1 * byProxy 2 = 240.
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
        const deleteRes = await VISITS_DELETE(new Request('http://localhost:4000/api/facility/visits', {
            method: 'DELETE',
            body: JSON.stringify({ visitId: visit.id }),
        }) as unknown as import('next/server').NextRequest);
        expect(deleteRes.status).toBe(200);

        const deleteAudit = await prisma.auditLog.findFirst({
            where: { actorId: adminId, action: 'DELETE', tableName: 'Visit', affectedEntityId: visit.id },
            orderBy: { id: 'desc' },
        });
        expect((deleteAudit?.newData as { significance?: { score: number; flagged: boolean } })?.significance)
            .toEqual({ score: 240, flagged: true });

        await prisma.programVolunteer.deleteMany({ where: { programId: program.id } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'Visit', affectedEntityId: visit.id } });
        await prisma.event.delete({ where: { id: event.id } });
        await prisma.program.delete({ where: { id: program.id } });
    });

    // A member self-correction (PATCH /api/attendance/manual/[id]) restamps the
    // corrected arrival to TYPED: after the edit the value is the member's own
    // typed clock, so a second correction weighs it as a self-report, not the
    // original LEAD_MARKED observation. bySource attributes the corrected hours
    // to TYPED accordingly; the hours themselves count either way.
    it('keeps a self-corrected visit counted, and restamps its source to TYPED', async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `SelfCorrectedLM ${TAG}` } });
        const event = await prisma.event.create({
            data: { programId: program.id, name: `SelfCorrectedLM event ${TAG}`, startAt: arrival(2), endAt: departure(2, 3) },
        });
        const now = Date.now();
        const visit = await prisma.visit.create({
            data: {
                personId: volunteerId,
                arrivedAt: new Date(now - 4 * 3600000),
                departedAt: new Date(now - 2 * 3600000),
                arrivedVia: 'LEAD_MARKED',
                departedVia: 'LEAD_MARKED',
                associatedEventId: event.id,
            },
        });
        visitIds.push(visit.id);

        const before = await (await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${program.id}`)).json();
        expect(before.totals.totalVolunteerHours).toBe(2);

        // The member corrects their own arrival — a household lead is not needed here.
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: volunteerId } });
        const patch = await MANUAL_PATCH(new Request(`http://localhost:4000/api/attendance/manual/${visit.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ arrivedAt: new Date(now - 3 * 3600000).toISOString() }),
        }) as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: String(visit.id) }) } as never);
        expect(patch.status).toBe(200);
        const patched = await prisma.visit.findUnique({ where: { id: visit.id } });
        expect(patched?.arrivedVia).toBe('TYPED'); // corrected arrival is now a typed clock — the point of this test

        // Counted before and after, at the corrected 1h.
        const after = await (await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${program.id}`)).json();
        expect(after.totals.uniqueVolunteers).toBe(1);
        expect(after.totals.totalVolunteerHours).toBe(1);
        expect(after.totals.structuredHours).toBe(1);

        await prisma.auditLog.deleteMany({ where: { tableName: 'Visit', affectedEntityId: visit.id } });
        await prisma.visit.delete({ where: { id: visit.id } });
        await prisma.event.delete({ where: { id: event.id } });
        await prisma.program.delete({ where: { id: program.id } });
    });

    // Control: a SCANNER visit's self-correction restamps to TYPED too — the
    // first correction weighs the badge measurement (SCANNER=3), and the row is
    // left TYPED so the next correction weighs a self-report (TYPED=1). It still
    // applies and still counts.
    it('restamps a self-corrected SCANNER visit to TYPED after the manual PATCH route', async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `SelfCorrectedScanner ${TAG}` } });
        const event = await prisma.event.create({
            data: { programId: program.id, name: `SelfCorrectedScanner event ${TAG}`, startAt: arrival(2), endAt: departure(2, 3) },
        });
        const now = Date.now();
        const visit = await prisma.visit.create({
            data: {
                personId: volunteerId,
                arrivedAt: new Date(now - 4 * 3600000),
                departedAt: new Date(now - 2 * 3600000),
                arrivedVia: 'SCANNER',
                departedVia: 'SCANNER',
                associatedEventId: event.id,
            },
        });
        visitIds.push(visit.id);

        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: volunteerId } });
        const patch = await MANUAL_PATCH(new Request(`http://localhost:4000/api/attendance/manual/${visit.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ arrivedAt: new Date(now - 3 * 3600000).toISOString() }),
        }) as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: String(visit.id) }) } as never);
        expect(patch.status).toBe(200);
        const patched = await prisma.visit.findUnique({ where: { id: visit.id } });
        expect(patched?.arrivedVia).toBe('TYPED'); // corrected badge arrival is now a typed clock

        const after = await (await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${program.id}`)).json();
        expect(after.totals.uniqueVolunteers).toBe(1);
        expect(after.totals.totalVolunteerHours).toBe(1);
        expect(after.totals.structuredHours).toBe(1);

        await prisma.auditLog.deleteMany({ where: { tableName: 'Visit', affectedEntityId: visit.id } });
        await prisma.visit.delete({ where: { id: visit.id } });
        await prisma.event.delete({ where: { id: event.id } });
        await prisma.program.delete({ where: { id: program.id } });
    });

    it('scopes to a single program via programId', async () => {
        const res = await callAs({ id: adminId, isSysadmin: true }, `?period=month&programId=${otherProgramId}`);
        expect(res.status).toBe(200);
        const data = await res.json();
        // No visits are associated with otherProgramId's events (it has none) — empty result.
        expect(data.buckets).toEqual([]);
        expect(data.totals.uniqueVolunteers).toBe(0);
        expect(data.totals.uniqueParticipants).toBe(0);
    });
});
