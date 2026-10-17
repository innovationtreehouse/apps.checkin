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
 *    is reported through the reused Shopify-failure channel but NEVER mutated.
 *  - clean: a row that validates clean produces no violation.
 *  - authz: the System Status GET rejects anon (401) and a plain user (403) —
 *    the negative-authz coverage authzRegistry.test.ts requires.
 *
 * Shopify is mocked (no network): the reconciler imports only adjustProgramInventory
 * + reportShopifyFailure from @/lib/shopify, so replacing the whole module with two
 * jest.fn()s is sufficient (SWC's non-configurable exports block jest.spyOn).
 */
import { adjustProgramInventory, reportShopifyFailure } from '@/lib/shopify';
import { runLifecycleReconcile, scanLifecycleViolations } from '@/lib/lifecycleDrift';
import { GET as LIFECYCLE_GET } from '@/app/api/system-status/lifecycle/route';
import prisma from '@/lib/prisma';
import { toRow, validate } from '@/lib/programs/enrollmentState';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/shopify', () => ({
    __esModule: true,
    adjustProgramInventory: jest.fn(),
    reportShopifyFailure: jest.fn(),
}));

const adjustSpy = adjustProgramInventory as jest.Mock;
const reportSpy = reportShopifyFailure as jest.Mock;

const TAG = 'lifecycle-reconcile-test';
const VARIANT = `dev-mock-variant-${TAG}`;

describe('lifecycle reconciler — invariant-driven sweep over a real DB', () => {
    let programId: number;
    let selfId: number;
    const processIds: number[] = [];

    beforeAll(async () => {
        const self = await prisma.person.create({
            data: { name: 'LCR Self', email: `self-${TAG}@example.com`, household: { create: { name: 'HH' } } },
        });
        selfId = self.id;
        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `LCR Program ${TAG}`, enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), shopifyVariantId: VARIANT },
        });
        programId = program.id;
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'ProgramParticipant', secondaryAffectedEntity: programId } });
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
    });

    afterEach(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        if (processIds.length) await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
        processIds.length = 0;
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
        const reportedMine = reportSpy.mock.calls.some(
            (c) => typeof c[1]?.message === 'string' && c[1].message.includes(`person ${selfId}`),
        );
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

        // Reported through the reused channel, keyed to this row + its invariant.
        const reportedMine = reportSpy.mock.calls.some((c) => {
            const ctx = c[2] as { key?: string; invariant?: string } | undefined;
            return ctx?.key === `process ${proc.id}` && ctx?.invariant === 'intake-is-unpaid';
        });
        expect(reportedMine).toBe(true);

        // NOT mutated — a human resolves ambiguous violations.
        const after = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: proc.id } });
        expect(after.status).toBe('INTAKE');
        expect(after.paidAt).not.toBeNull();
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
