/**
 * @jest-environment node
 */
/**
 * Integration tests for GET /api/cron/scholarship-grace-expiry — release path
 * (c) of the hold-ledger (product decision 2026-07-06). A denied scholarship
 * applicant keeps their held seat (inventoryHeldAt stays set; the refuse
 * endpoint performs no Shopify op) so they can still pay. Once
 * BoardSettings.scholarshipDenialGraceDays has elapsed since
 * paymentPlanDeniedAt, this sweep auto-withdraws the participant and releases
 * the seat (+1) — reusing the same withdrawAndReleaseHold path self/admin
 * withdrawal uses.
 */
import { GET } from '@/app/api/cron/scholarship-grace-expiry/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS - DAY_MS / 2); // half-day offset keeps boundaries stable

function mkReq(auth?: string) {
    return new Request('http://localhost:4000/api/cron/scholarship-grace-expiry', {
        method: 'GET',
        headers: auth ? { authorization: auth } : {},
    }) as unknown as Request;
}

describe('Cron Scholarship-Grace-Expiry API Integration Tests', () => {
    let programId: number;
    const ids: Record<string, number> = {};
    let restoreBoardSettings: () => Promise<void> = async () => {};

    const mkParticipant = async (key: string) => {
        const p = await prisma.person.create({
            data: { email: `${key}-grace-cron-test@example.com`, name: `${key} Grace Cron`, household: { create: { name: 'Test HH' } } },
        });
        ids[key] = p.id;
        return p.id;
    };

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({ where: { email: { contains: 'grace-cron-test' } }, select: { id: true } });
        const leakedIds = leaked.map((u) => u.id);
        await prisma.programParticipant.deleteMany({ where: { personId: { in: leakedIds } } });
        await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
        await prisma.program.deleteMany({ where: { name: { contains: 'Grace Cron Test' } } });

        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Grace Cron Test Program', phase: 'UPCOMING', enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-grace-cron' },
        });
        programId = program.id;

        restoreBoardSettings = await snapshotBoardSettings();

        await mkParticipant('inside'); // denied 3 days ago — inside a 7-day grace window
        await mkParticipant('outside'); // denied 10 days ago — past a 7-day grace window
        await mkParticipant('active'); // ACTIVE + (hypothetically) held — must never be touched
        await mkParticipant('gone'); // pre-deleted before the sweep runs — per-row isolation
    });

    afterAll(async () => {
        const idList = Object.values(ids);
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.person.deleteMany({ where: { id: { in: idList } } });
        await prisma.program.deleteMany({ where: { id: programId } });
        await restoreBoardSettings();
    });

    describe('auth', () => {
        it('returns 401 when the Authorization header is missing', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const res = await GET(mkReq());
            expect(res.status).toBe(401);
        });
    });

    describe('NULL setting — feature off', () => {
        it('no-ops entirely when scholarshipDenialGraceDays is NULL', async () => {
            await prisma.boardSettings.upsert({
                where: { id: 1 },
                create: { id: 1, scholarshipDenialGraceDays: null },
                update: { scholarshipDenialGraceDays: null },
            });
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId: ids.outside } },
                update: { status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(10), paymentPlanDeniedAt: daysAgo(10) },
                create: { programId, personId: ids.outside, status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(10), paymentPlanDeniedAt: daysAgo(10) },
            });

            process.env.CRON_SECRET = 'test-secret';
            const res = await GET(mkReq('Bearer test-secret'));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.enabled).toBe(false);
            expect(data.processed).toBe(0);

            const row = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId: ids.outside } } });
            expect(row).not.toBeNull(); // untouched
        });
    });

    describe('sweep boundary + isolation, graceDays=7', () => {
        beforeAll(async () => {
            await prisma.boardSettings.upsert({
                where: { id: 1 },
                create: { id: 1, scholarshipDenialGraceDays: 7 },
                update: { scholarshipDenialGraceDays: 7 },
            });

            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId: ids.inside } },
                update: { status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(3), paymentPlanDeniedAt: daysAgo(3) },
                create: { programId, personId: ids.inside, status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(3), paymentPlanDeniedAt: daysAgo(3) },
            });
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId: ids.outside } },
                update: { status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(10), paymentPlanDeniedAt: daysAgo(10) },
                create: { programId, personId: ids.outside, status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(10), paymentPlanDeniedAt: daysAgo(10) },
            });
            // ACTIVE with a (hypothetical) hold set — the status filter must exclude it.
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId: ids.active } },
                update: { status: 'ACTIVE', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(30), paymentPlanDeniedAt: daysAgo(30) },
                create: { programId, personId: ids.active, status: 'ACTIVE', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(30), paymentPlanDeniedAt: daysAgo(30) },
            });
            // Past the window too, but its removal is forced to fail below (see
            // the delete() spy) — must not block processing the rest of the sweep.
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId: ids.gone } },
                update: { status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(20), paymentPlanDeniedAt: daysAgo(20) },
                create: { programId, personId: ids.gone, status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: daysAgo(20), paymentPlanDeniedAt: daysAgo(20) },
            });
        });

        it('releases + auto-withdraws only rows past the grace window, isolates a per-row failure, and never touches ACTIVE rows', async () => {
            const prevEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            process.env.CRON_SECRET = 'test-secret';

            // Force one row's removal to fail, simulating any per-row error (DB
            // hiccup, concurrent removal, etc.) without it blocking the rest of
            // the sweep.
            const originalDelete = prisma.programParticipant.delete.bind(prisma.programParticipant);
            const deleteSpy = jest.spyOn(prisma.programParticipant, 'delete').mockImplementation((args: Parameters<typeof originalDelete>[0]) => {
                if (args?.where?.programId_personId?.personId === ids.gone) {
                    throw new Error('simulated per-row failure');
                }
                return originalDelete(args);
            });

            try {
                const res = await GET(mkReq('Bearer test-secret'));
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.enabled).toBe(true);
                // outside + gone both matched the query (paymentPlanDeniedAt <= cutoff);
                // "gone" throws on delete() and is isolated, not counted as released.
                expect(data.processed).toBe(2);
                expect(data.released).toBe(1);
                // Isolating the row keeps the sweep going; it does not make the run
                // healthy. The run completed, so `success` stays true — the ledger
                // records the failure on `error` instead, which is what the panel reads.
                expect(data.failed).toBe(1);
                const ledger = await prisma.cronRunLog.findFirst({ where: { job: 'scholarship-grace-expiry' }, orderBy: { id: 'desc' } });
                expect(ledger?.success).toBe(true);
                expect(ledger?.error).toBe('1 item(s) failed');

                // Inside the window: untouched.
                const inside = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId: ids.inside } } });
                expect(inside).not.toBeNull();
                expect(inside?.status).toBe('PENDING');

                // Outside the window: auto-withdrawn (row gone) + released (+1 logged).
                const outside = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId: ids.outside } } });
                expect(outside).toBeNull();
                expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory by 1 for variant: dev-mock-variant-grace-cron'));

                const audit = await prisma.auditLog.findFirst({
                    where: { actorId: 0, tableName: 'ProgramParticipant', affectedEntityId: ids.outside, secondaryAffectedEntity: programId },
                });
                expect(audit).not.toBeNull();
                expect((audit?.newData as { reason?: string })?.reason).toBe('scholarship_grace_expired');

                // The row whose removal failed: untouched, isolated from the rest.
                const gone = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId: ids.gone } } });
                expect(gone).not.toBeNull();

                // ACTIVE row: never touched by the sweep despite being way outside the window.
                const active = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId: ids.active } } });
                expect(active).not.toBeNull();
                expect(active?.status).toBe('ACTIVE');
                expect(active?.inventoryHeldAt).not.toBeNull();
            } finally {
                deleteSpy.mockRestore();
                logSpy.mockRestore();
                if (prevEnv === undefined) delete process.env.CHECKIN_ENV;
                else process.env.CHECKIN_ENV = prevEnv;
            }
        });
    });
});
