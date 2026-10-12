/**
 * @jest-environment node
 */
import { GET } from '@/app/api/cron/nightly/route';
import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/email';
import { MAX_VISIT_MS } from '@/lib/visitTimes';

jest.mock('@/lib/email', () => ({
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
    sendEmail: jest.fn().mockResolvedValue(true)
}));

// Per-visit failure injection: the route checks out every open visit via
// processVisitCheckout under Promise.allSettled. We wrap the real function so
// that only the visit ids we opt in (mockBadVisitIds) reject; every other id
// runs the genuine DB logic. `mock`-prefixed name so jest's hoist allows the
// factory to close over it.
const mockBadVisitIds = new Set<number>();
jest.mock('@/lib/attendanceTransitions', () => {
    const actual = jest.requireActual('@/lib/attendanceTransitions');
    return {
        __esModule: true,
        ...actual,
        processVisitCheckout: jest.fn((visitId: number, checkoutTime: Date, db?: unknown, source?: unknown, facilityCloseId?: unknown) => {
            if (mockBadVisitIds.has(visitId)) {
                return Promise.reject(new Error(`Simulated checkout failure for visit ${visitId}`));
            }
            return actual.processVisitCheckout(visitId, checkoutTime, db, source, facilityCloseId);
        }),
    };
});

describe('Cron Nightly API Integration Tests', () => {
    let boardMemberId: number;
    let keyholderId: number;
    let normalUserId: number;

    let programId: number;
    let eventId: number;

    beforeAll(async () => {
        await cleanup();

        // Setup Users
        const board = await prisma.person.create({
            data: { email: 'board-nightly@example.com', name: 'Board Member', isBoardMember: true, household: { create: { name: "Test HH" } } }
        });
        boardMemberId = board.id;

        const isKeyholder = await prisma.person.create({
            data: { email: 'keyholder-nightly@example.com', name: 'Forgetful Keyholder', isKeyholder: true, household: { create: { name: "Test HH" } } }
        });
        keyholderId = isKeyholder.id;

        const normalUser = await prisma.person.create({
            data: { email: 'user-nightly@example.com', name: 'Normal User', household: { create: { name: "Test HH" } } }
        });
        normalUserId = normalUser.id;

        // Setup Program & Event for emails
        const program = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: 'Nightly Test Program',
                leadMentorId: boardMemberId // Board member is also lead
            }
        });
        programId = program.id;

        const now = new Date();
        const justEndedStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        // Event ended 5 minutes ago (would NOT trigger standard 1-hour cron, but SHOULD trigger nightly)
        const justEndedEnd = new Date(now.getTime() - 5 * 60 * 1000); 

        const event = await prisma.event.create({
            data: {
                name: 'Test Event - Nightly',
                startAt: justEndedStart,
                endAt: justEndedEnd,
                programId,
                postEventEmailSent: false
            }
        });
        eventId = event.id;

        await prisma.rSVP.create({
            data: { eventId, personId: normalUserId, status: 'ATTENDING' }
        });

        // Setup Abandoned Visits
        await prisma.visit.create({
            data: { personId: keyholderId, arrivedAt: justEndedStart } // Never departedAt
        });

        await prisma.visit.create({
            data: { personId: normalUserId, arrivedAt: justEndedStart, associatedEventId: eventId } // Never departedAt
        });
    });

    afterAll(async () => {
        await cleanup();
    });

    async function cleanup() {
        // Broad cleanup for nightly tests
        await prisma.rSVP.deleteMany({ where: { person: { email: { contains: '-nightly@' } } } });
        await prisma.visit.deleteMany({ where: { person: { email: { contains: '-nightly@' } } } });
        await prisma.event.deleteMany({ where: { name: { startsWith: 'Test Event - Nightly' } } });
        await prisma.program.deleteMany({ where: { name: 'Nightly Test Program' } });
        await prisma.auditLog.deleteMany();

        // RESTRICT: delete participants before their (auto-created) households.
        const householdIds = (await prisma.person.findMany({
            where: { email: { contains: '-nightly@' } },
            select: { householdId: true }
        })).map(p => p.householdId);

        await prisma.person.deleteMany({
            where: { email: { contains: '-nightly@' } }
        });
        await prisma.household.deleteMany({
            where: { id: { in: householdIds } }
        });
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/cron/nightly', () => {
        it('should force checkout abandoned visits and send post-event emails immediately', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const req = new Request('http://localhost:4000/api/cron/nightly', {
                method: 'GET',
                headers: {
                    'authorization': 'Bearer test-secret'
                }
            });

            const res = await GET(req);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);

            // 1. Verify Facility Close Logic
            expect(data.facilityClose.checkedOutCount).toBe(2); // Keyholder + Normal User
            expect(data.facilityClose.boardNotified).toBe(true); // Because a isKeyholder was abandoned

            // 2. Verify Post-Event Email Logic
            expect(data.postEvents.processedEvents).toBe(1);
            expect(data.postEvents.emailsSent).toBe(1);

            // Db checks
            const abandonedVisits = await prisma.visit.findMany({
                where: { departedAt: null, person: { email: { contains: '-nightly@' } } }
            });
            expect(abandonedVisits.length).toBe(0); // Everyone checked out

            const updatedEvent = await prisma.event.findUnique({ where: { id: eventId } });
            expect(updatedEvent?.postEventEmailSent).toBe(true); // Email sent

            expect(sendEmail).toHaveBeenCalledWith(
                'board-nightly@example.com',
                `Action Required: Confirm Attendance for Test Event - Nightly`,
                expect.stringContaining('Review & Confirm Attendance')
            );
        });

        const cronReq = () => {
            process.env.CRON_SECRET = 'test-secret';
            return new Request('http://localhost:4000/api/cron/nightly', {
                method: 'GET',
                headers: { 'authorization': 'Bearer test-secret' }
            });
        };

        // Close any visit still open from a prior test so the route's global
        // `departedAt: null` sweep counts only the visits this test creates.
        async function closeAllOpenVisits() {
            await prisma.visit.updateMany({
                where: { departedAt: null },
                data: { departedAt: new Date() }
            });
        }

        const systemNotifyCount = () =>
            prisma.auditLog.count({ where: { tableName: 'SYSTEM_NOTIFY' } });

        // The System Status pill is the only in-app signal that the sweeps still
        // work, and it reads the CronRunLog. A night that checked NOBODY out must
        // not land there as a clean success — nor as "job stopped running", which is
        // a different failure the board would chase into the scheduler.
        it('records the run as unclean, not as stopped, when every checkout fails', async () => {
            await closeAllOpenVisits();
            await prisma.auditLog.deleteMany();

            const arrivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const one = await prisma.visit.create({ data: { personId: normalUserId, arrivedAt } });
            const two = await prisma.visit.create({ data: { personId: keyholderId, arrivedAt } });

            mockBadVisitIds.clear();
            mockBadVisitIds.add(one.id);
            mockBadVisitIds.add(two.id);

            try {
                const res = await GET(cronReq());
                expect(res.status).toBe(200);

                const data = await res.json();
                expect(data.facilityClose.checkedOutCount).toBe(0);
                expect(data.failed).toBe(2);

                // Both visits are still open — nothing was swept.
                expect(await prisma.visit.count({ where: { id: { in: [one.id, two.id] }, departedAt: null } })).toBe(2);

                // The run COMPLETED (so the job never reads as "stopped") but was not
                // clean — both facts recorded, on the two separate ledger columns.
                const ledger = await prisma.cronRunLog.findFirst({ where: { job: 'nightly' }, orderBy: { id: 'desc' } });
                expect(ledger?.success).toBe(true);
                expect(ledger?.error).toBe('2 item(s) failed');
            } finally {
                mockBadVisitIds.clear();
            }
        });

        it('keeps checking out good visits when ONE visit fails, still notifies the board, and returns 200', async () => {
            await closeAllOpenVisits();
            await prisma.auditLog.deleteMany();

            const arrivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

            // An extra plain participant (no program enrollment -> simple close path)
            // so we have two GOOD visits whose `departedAt` we can assert by id.
            const extra = await prisma.person.create({
                data: { email: 'extra-nightly@example.com', name: 'Extra User', household: { create: { name: "Test HH" } } }
            });

            const badVisit = await prisma.visit.create({
                data: { personId: keyholderId, arrivedAt } // isKeyholder -> triggers board notify
            });
            const goodVisitA = await prisma.visit.create({
                data: { personId: normalUserId, arrivedAt }
            });
            const goodVisitB = await prisma.visit.create({
                data: { personId: extra.id, arrivedAt }
            });

            mockBadVisitIds.clear();
            mockBadVisitIds.add(badVisit.id); // isKeyholder's checkout will throw

            try {
                const res = await GET(cronReq());

                // Route survives the bad visit instead of 500-ing.
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.success).toBe(true);

                // 2 good visits checked out; the bad one is NOT counted as success,
                // and the run reports it so the ledger can mark the sweep unhealthy.
                expect(data.facilityClose.checkedOutCount).toBe(2);
                expect(data.failed).toBe(1);

                // Board still notified even though the isKeyholder's checkout failed
                // (notification derives from the abandoned-visit list, not results).
                expect(data.facilityClose.boardNotified).toBe(true);
                expect(await systemNotifyCount()).toBe(1);

                // Good visits really departedAt; the failed one stays open.
                const a = await prisma.visit.findUnique({ where: { id: goodVisitA.id } });
                const b = await prisma.visit.findUnique({ where: { id: goodVisitB.id } });
                const bad = await prisma.visit.findUnique({ where: { id: badVisit.id } });
                expect(a?.departedAt).not.toBeNull();
                expect(b?.departedAt).not.toBeNull();
                expect(bad?.departedAt).toBeNull();
            } finally {
                mockBadVisitIds.clear();
            }
        });

        it('is idempotent on re-run: second sweep checks out nothing, writes no new audit, sends no email', async () => {
            await closeAllOpenVisits();
            await prisma.auditLog.deleteMany();
            mockBadVisitIds.clear();

            // Let the post-event email fire again on run 1 so we can prove run 2 does not re-send.
            await prisma.event.update({ where: { id: eventId }, data: { postEventEmailSent: false } });

            const arrivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
            await prisma.visit.create({ data: { personId: keyholderId, arrivedAt } });
            await prisma.visit.create({ data: { personId: normalUserId, arrivedAt, associatedEventId: eventId } });

            // --- Run 1: real work happens ---
            const res1 = await GET(cronReq());
            expect(res1.status).toBe(200);
            const data1 = await res1.json();
            expect(data1.facilityClose.checkedOutCount).toBe(2);
            expect(data1.facilityClose.boardNotified).toBe(true);
            expect(data1.postEvents.emailsSent).toBe(1);
            expect(await systemNotifyCount()).toBe(1);
            expect(sendEmail).toHaveBeenCalledTimes(1);

            jest.clearAllMocks();

            // --- Run 2: overlap/retry must be a no-op ---
            const res2 = await GET(cronReq());
            expect(res2.status).toBe(200);
            const data2 = await res2.json();
            expect(data2.facilityClose.checkedOutCount).toBe(0); // nothing left open
            expect(data2.facilityClose.boardNotified).toBe(false); // no abandoned isKeyholder
            expect(data2.postEvents.emailsSent).toBe(0); // email already sent

            expect(await systemNotifyCount()).toBe(1); // no NEW force-checkout audit row
            expect(sendEmail).not.toHaveBeenCalled(); // no duplicate board/post-event email
        });

        it('caps a visit the sweep missed at arrival + MAX_VISIT_MS instead of stamping run time', async () => {
            await closeAllOpenVisits();
            await prisma.auditLog.deleteMany();
            mockBadVisitIds.clear();

            const arrivedAt = new Date(Date.now() - 30 * 60 * 60 * 1000);
            const missed = await prisma.visit.create({ data: { personId: normalUserId, arrivedAt } });

            const res = await GET(cronReq());
            expect(res.status).toBe(200);

            const closed = await prisma.visit.findUnique({ where: { id: missed.id } });
            expect(closed?.departedAt).toEqual(new Date(arrivedAt.getTime() + MAX_VISIT_MS));
            expect(closed?.departedVia).toBe('AUTO_CLOSE');
        });

        it('audits the DoB purge per person, attributed to cron:nightly, without recording the date', async () => {
            await closeAllOpenVisits();
            await prisma.auditLog.deleteMany();
            mockBadVisitIds.clear();

            const dob = new Date(Date.UTC(1990, 3, 17));
            const agedOut = await prisma.person.create({
                data: {
                    email: 'agedout-nightly@example.com',
                    name: 'Aged Out',
                    dateOfBirth: dob,
                    household: { create: { name: 'Test HH' } }
                }
            });

            const res = await GET(cronReq());
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.adultDobPurged).toBeGreaterThanOrEqual(1);

            const purged = await prisma.person.findUnique({ where: { id: agedOut.id } });
            expect(purged?.dateOfBirth).toBeNull();
            expect(purged?.isDeclaredAdult).toBe(true);

            const row = await prisma.auditLog.findFirst({
                where: { tableName: 'Person', affectedEntityId: agedOut.id, action: 'DELETE' }
            });
            expect(row).not.toBeNull();
            expect(row?.actorId).toBe(0);
            expect(row?.actorSystem).toBe('cron:nightly');

            // The purge exists to destroy the date; a row that carries it out
            // has re-stored it. Scan every field the purge wrote, not just the
            // one we expect the date to hide in, so a later `context` blob or a
            // pre-image in `oldData` fails here too. `timestamp` is excluded —
            // it is the audit's own clock, not anybody's date of birth.
            const purgeRows = await prisma.auditLog.findMany({
                where: { tableName: 'Person', actorSystem: 'cron:nightly', action: 'DELETE' }
            });
            expect(purgeRows.length).toBeGreaterThanOrEqual(1);
            for (const r of purgeRows) {
                const serialized = JSON.stringify({ ...r, timestamp: undefined });
                expect(serialized).not.toContain(String(dob.getTime()));
                expect(serialized).not.toContain(dob.toISOString());
                expect(serialized).not.toContain(dob.toISOString().slice(0, 10));

                // Anything date-shaped, in any format, anywhere a value can be
                // carried. Scoped to the free-form columns because the numeric
                // id columns are autoincrement and can hit a year by accident.
                const payload = JSON.stringify({
                    actorSystem: r.actorSystem,
                    tableName: r.tableName,
                    oldData: r.oldData,
                    newData: r.newData
                });
                expect(payload).not.toMatch(/\b(?:19|20)\d{2}\b/);
                expect(payload).not.toMatch(/dateOfBirth"\s*:\s*(?!null)[^,}]/);
            }
        });
    });
});
