/**
 * @jest-environment node
 */
/**
 * Integration tests for the invariant-driven lifecycle reconciler
 * against a real DB.
 *
 *  - I1 heal: an ACTIVE enrollment with a stranded `inventoryHeldAt` (the two-step
 *    crash window) is cleared, the missed `+1` is fired via
 *    adjustProgramInventory, an AuditLog row records the heal, and the row then
 *    validates clean.
 *  - report-only: a non-I1 violation (membership `paidAt` on an INTAKE process)
 *    is reported in the drift digest but NEVER mutated.
 *  - digest: one email per run for many rows, split into new and still present,
 *    nothing through the Shopify failure channel.
 *  - job history: a thrown heal records a failed item on the cron run.
 *  - clean: a row that validates clean produces no violation.
 *  - authz: the System Status GET rejects anon (401) and a plain user (403) —
 *    the negative-authz coverage authzRegistry.test.ts requires.
 *
 * Shopify and email are mocked (no network). The Shopify client mock exists to prove
 * the reconciler never reports through it (SWC's non-configurable exports block jest.spyOn).
 */
import { reportShopifyFailure } from '@/lib/shopify/client';
import { adjustProgramInventory, changeProgramStockWith } from '@/lib/shopify/stock';
import { sendTemplated } from '@/lib/email-templates/send';
import { GET as CRON_GET } from '@/app/api/cron/lifecycle-reconcile/route';
import { runLifecycleReconcile, scanLifecycleViolations } from '@/lib/lifecycleDrift';
import { GET as LIFECYCLE_GET } from '@/app/api/system-status/lifecycle/route';
import prisma from '@/lib/prisma';
import { toRow, validate } from '@/lib/programs/enrollmentState';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/shopify/stock', () => ({
    __esModule: true,
    adjustProgramInventory: jest.fn(),
    changeProgramStockWith: jest.fn((...a: unknown[]) => jest.requireActual('@/test-helpers/stockWith').forwardStockWith(...a)),
}));
jest.mock('@/lib/shopify/client', () => ({
    __esModule: true,
    reportShopifyFailure: jest.fn(),
}));

jest.mock('@/lib/email-templates/send', () => ({
    __esModule: true,
    sendTemplated: jest.fn(),
}));

const adjustSpy = adjustProgramInventory as jest.Mock;
const reportSpy = reportShopifyFailure as jest.Mock;
const sendSpy = sendTemplated as jest.Mock;

const TAG = 'lifecycle-reconcile-test';
const VARIANT = `dev-mock-variant-${TAG}`;
const ADMIN_EMAIL = `self-${TAG}@example.com`;

/** The digests the seeded sysadmin received in this test. */
const digests = () => sendSpy.mock.calls
    .filter((c) => c[0] === 'lifecycle.driftDigest' && c[1] === ADMIN_EMAIL)
    .map((c) => c[2] as { newList: string; stillPresentList: string });

describe('lifecycle reconciler — invariant-driven sweep over a real DB', () => {
    let programId: number;
    let selfId: number;
    const processIds: number[] = [];

    beforeAll(async () => {
        const self = await prisma.person.create({
            data: { name: 'LCR Self', email: ADMIN_EMAIL, isSysadmin: true, household: { create: { name: 'HH' } } },
        });
        selfId = self.id;
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `LCR Program ${TAG}`, enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), shopifyVariantId: VARIANT },
        });
        programId = program.id;
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'ProgramParticipant', secondaryAffectedEntity: programId } });
        await prisma.integrationErrorLog.deleteMany({ where: { source: 'lifecycle-drift' } });
        await prisma.cronRunLog.deleteMany({ where: { job: 'lifecycle-reconcile' } });
        await prisma.program.delete({ where: { id: programId } });
        const person = await prisma.person.findUnique({ where: { id: selfId }, select: { householdId: true } });
        await prisma.person.delete({ where: { id: selfId } });
        if (person) await prisma.household.deleteMany({ where: { id: person.householdId } });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Default: no network, calls succeed. Individual specs assert against these.
        adjustSpy.mockResolvedValue(true);
        reportSpy.mockResolvedValue(undefined);
        sendSpy.mockResolvedValue(true);
    });

    afterEach(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        if (processIds.length) await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
        processIds.length = 0;
        await prisma.lifecycleDriftReport.deleteMany({});
    });

    it('I1: heals ACTIVE + stranded hold — clears held, fires +1, audit-logs, validates clean', async () => {
        await prisma.programParticipant.create({
            data: { programId, personId: selfId, status: 'ACTIVE', inventoryHeldAt: new Date() },
        });

        const summary = await runLifecycleReconcile();

        // Row healed: hold cleared, now on-diagram.
        const row = await prisma.programParticipant.findUniqueOrThrow({
            where: { programId_personId: { programId, personId: selfId } },
        });
        expect(row.inventoryHeldAt).toBeNull();
        expect(row.status).toBe('ACTIVE');
        expect(validate(toRow(row))).toBeNull();

        // The missed release fired: adjustProgramInventory(program, +1).
        expect(adjustSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: programId, shopifyVariantId: VARIANT }),
            1,
            'reconcile-heal',
        );

        // Audit trail for the heal.
        const audit = await prisma.auditLog.findFirst({
            where: { tableName: 'ProgramParticipant', affectedEntityId: selfId, secondaryAffectedEntity: programId, action: 'EDIT' },
        });
        expect(audit).not.toBeNull();

        // A healed row is NOT also reported to the board.
        expect(summary.healed).toBeGreaterThanOrEqual(1);
        const reportedMine = digests().some((d) => d.newList.includes(`person ${selfId}`));
        expect(reportedMine).toBe(false);
    });

    it('I1: once the sale has ended, clears the stranded hold without a +1', async () => {
        await prisma.program.update({ where: { id: programId }, data: { saleEndedAt: new Date() } });
        try {
            await prisma.programParticipant.create({
                data: { programId, personId: selfId, status: 'ACTIVE', inventoryHeldAt: new Date() },
            });

            await runLifecycleReconcile();

            const row = await prisma.programParticipant.findUniqueOrThrow({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row.inventoryHeldAt).toBeNull();
            expect(adjustSpy).not.toHaveBeenCalledWith(expect.objectContaining({ shopifyVariantId: VARIANT }), expect.anything());
        } finally {
            await prisma.program.update({ where: { id: programId }, data: { saleEndedAt: null } });
        }
    });

    it('non-I1: reports a membership INTAKE-with-payment violation but does NOT mutate it', async () => {
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', status: 'INTAKE', subjectPersonId: selfId, paidAt: new Date() },
        });
        processIds.push(proc.id);

        await runLifecycleReconcile();

        expect(digests()[0].newList).toContain(`process ${proc.id}: invariant intake-is-unpaid`);

        // NOT mutated — a human resolves ambiguous violations.
        const after = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: proc.id } });
        expect(after.status).toBe('INTAKE');
        expect(after.paidAt).not.toBeNull();
    });

    const offDiagramProcess = async () => {
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', status: 'INTAKE', subjectPersonId: selfId, paidAt: new Date() },
        });
        processIds.push(proc.id);
        return proc.id;
    };

    it('sends one digest for many rows, and nothing through the Shopify channel', async () => {
        const first = await offDiagramProcess();
        const second = await offDiagramProcess();

        await runLifecycleReconcile();

        expect(digests()).toHaveLength(1);
        expect(digests()[0].newList).toContain(`process ${first}:`);
        expect(digests()[0].newList).toContain(`process ${second}:`);
        expect(reportSpy).not.toHaveBeenCalled();
        const logged = await prisma.integrationErrorLog.findMany({ where: { source: 'shopify', message: { contains: `process ${first}` } } });
        expect(logged).toEqual([]);
        expect(await prisma.integrationErrorLog.count({ where: { source: 'lifecycle-drift' } })).toBeGreaterThanOrEqual(1);
    });

    it('a second run lists an unchanged row as still present and a later one as new', async () => {
        const first = await offDiagramProcess();
        await runLifecycleReconcile();
        const second = await offDiagramProcess();
        sendSpy.mockClear();

        await runLifecycleReconcile();

        const [digest] = digests();
        expect(digest.stillPresentList).toContain(`process ${first}:`);
        expect(digest.newList).not.toContain(`process ${first}:`);
        expect(digest.newList).toContain(`process ${second}:`);
    });

    it('a row that leaves and returns is new again', async () => {
        const id = await offDiagramProcess();
        await runLifecycleReconcile();

        await prisma.orgMembershipProcess.update({ where: { id }, data: { paidAt: null } });
        await runLifecycleReconcile();
        expect(await prisma.lifecycleDriftReport.count({ where: { key: `process ${id}` } })).toBe(0);

        await prisma.orgMembershipProcess.update({ where: { id }, data: { paidAt: new Date() } });
        sendSpy.mockClear();
        await runLifecycleReconcile();

        expect(digests()[0].newList).toContain(`process ${id}:`);
    });

    it('a digest nobody received fails the run and stays new', async () => {
        const id = await offDiagramProcess();
        sendSpy.mockResolvedValue(false);

        const summary = await runLifecycleReconcile();

        expect(summary.failed).toBe(1);
        expect(summary.reported).toBe(0);
        expect(await prisma.lifecycleDriftReport.count({ where: { key: `process ${id}` } })).toBe(0);
    });

    it('a thrown heal is a failed item on the job history, and the row stays in the digest', async () => {
        process.env.CRON_SECRET = 'test-secret';
        await prisma.programParticipant.create({
            data: { programId, personId: selfId, status: 'ACTIVE', inventoryHeldAt: new Date() },
        });
        (changeProgramStockWith as jest.Mock).mockRejectedValueOnce(new Error('heal failed'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        const res = await CRON_GET(new Request('http://localhost/api/cron/lifecycle-reconcile', {
            headers: { authorization: 'Bearer test-secret' },
        }));

        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
        expect((await res.json()).failed).toBe(1);
        const run = await prisma.cronRunLog.findFirstOrThrow({ where: { job: 'lifecycle-reconcile' }, orderBy: { id: 'desc' } });
        expect(run.success).toBe(true);
        expect(run.error).toBe('1 item(s) failed');
        expect(digests()[0].newList).toContain(`program ${programId} / person ${selfId}:`);
    });

    it('a settled PERSON_AGREEMENT is not a violation — the signature alone completes it', async () => {
        // markContractSigned flips an individual agreement straight to ACTIVE with no
        // bgClearedAt: it has no membership, no payment and no background-check gate.
        // Judging it by the membership convergence reports every adult child who signs.
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_AGREEMENT', status: 'ACTIVE', subjectPersonId: selfId, contractSignedAt: new Date() },
        });
        processIds.push(proc.id);

        const { violations } = await scanLifecycleViolations();

        expect(violations.filter((v) => v.key === `process ${proc.id}`)).toEqual([]);
    });

    it('clean: a row that validates clean produces no violation', async () => {
        await prisma.programParticipant.create({
            data: { programId, personId: selfId, status: 'ACTIVE', inventoryHeldAt: null },
        });

        const { violations } = await scanLifecycleViolations();

        const mine = violations.find((v) => v.key === `program ${programId} / person ${selfId}`);
        expect(mine).toBeUndefined();
    });

    it('authz: System Status GET rejects anon (401) and a plain user (403)', async () => {
        const req = () => new Request('http://localhost/api/system-status/lifecycle') as never;

        (getServerSession as jest.Mock).mockResolvedValue(null);
        expect((await LIFECYCLE_GET(req())).status).toBe(401);

        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: selfId, isSysadmin: false, isBoardMember: false },
        });
        expect((await LIFECYCLE_GET(req())).status).toBe(403);
    });
});
