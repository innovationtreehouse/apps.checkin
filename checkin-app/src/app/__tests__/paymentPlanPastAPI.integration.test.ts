/**
 * @jest-environment node
 */
/**
 * The Past view of both payment-plan queues, end to end against Postgres: board
 * decisions made through the real approve and refuse routes show up once with their
 * outcome and decider, even after the place is withdrawn, a decision known only from
 * its stamps still shows, the
 * pending queue keeps only pending requests, and a role outside the queue's
 * audience is refused.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET as ProgramPending, POST as ProgramApprove } from '@/app/api/finance-ops/payment-plans/route';
import { POST as ProgramRefuse } from '@/app/api/finance-ops/payment-plans/refuse/route';
import { GET as ProgramPast } from '@/app/api/finance-ops/payment-plans/past/route';
import { POST as MembershipApprove } from '@/app/api/finance-ops/membership-payment-plans/route';
import { POST as MembershipRefuse } from '@/app/api/finance-ops/membership-payment-plans/refuse/route';
import { GET as MembershipPast } from '@/app/api/finance-ops/membership-payment-plans/past/route';
import { DELETE as ParticipantExit } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email');

const mockSession = jest.mocked(getServerSession);
const TAG = 'payment-plan-past-test';

const get = (path: string) => new Request(`http://localhost${path}`) as unknown as NextRequest;
const post = (path: string, body: unknown) =>
    new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) }) as unknown as NextRequest;

type PastRow = { id: string; outcome: string; decidedByName: string | null; decidedAt: string | null };
type ProgramPastRow = PastRow & { personId: number; programId: number; personName: string; programName: string };
type MembershipPastRow = PastRow & { processId: number; householdName: string };

// Every page, since other suites on this worker database decide requests too.
async function allPast<T>(route: (req: NextRequest) => Promise<Response>, path: string): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 0; ; page++) {
        const res = await route(get(`${path}?page=${page}`));
        expect(res.status).toBe(200);
        const batch: T[] = await res.json();
        rows.push(...batch);
        if (batch.length === 0) return rows;
    }
}

async function wipe() {
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    const ids = people.map((p) => p.id);
    const programs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const households = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const hhIds = households.map((h) => h.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.programParticipant.deleteMany({ where: { programId: { in: programs.map((p) => p.id) } } });
    await prisma.program.deleteMany({ where: { id: { in: programs.map((p) => p.id) } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: hhIds } } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: hhIds } } });
    await prisma.person.deleteMany({ where: { id: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
}

let seq = 0;
async function person(label: string, extra: { isBoardMember?: boolean } = {}) {
    const n = seq++;
    return prisma.person.create({
        data: { name: `${label} ${n}`, email: `${label}-${n}-${TAG}@example.com`, ...extra, household: { create: { name: `${label} ${n} ${TAG}` } } },
    });
}

let boardId: number;
let boardName: string;
let financeId: number;
let otherId: number;

beforeAll(async () => {
    await wipe();
    const board = await person('Board', { isBoardMember: true });
    boardId = board.id;
    boardName = board.name;
    financeId = (await person('Finance')).id;
    otherId = (await person('Other')).id;
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

const asBoard = () => mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
const asFinance = () => mockSession.mockResolvedValue({ user: { id: financeId, isFinance: true } });
const asOther = () => mockSession.mockResolvedValue({ user: { id: otherId } });

describe('program payment plans — Past', () => {
    let programId: number;
    let approvedId: number;
    let refusedId: number;
    let stampOnlyId: number;
    let pendingId: number;

    beforeAll(async () => {
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Program ${TAG}`, phase: 'UPCOMING', enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), shopifyVariantId: 'dev-mock-variant-plan-past' },
        });
        programId = program.id;
        const requested = { programId, status: 'PENDING' as const, isPaymentPlanRequested: true, inventoryHeldAt: new Date() };
        approvedId = (await person('Approved')).id;
        refusedId = (await person('Refused')).id;
        stampOnlyId = (await person('Stamped')).id;
        pendingId = (await person('Pending')).id;
        await prisma.programParticipant.createMany({
            data: [
                { ...requested, personId: approvedId },
                { ...requested, personId: refusedId },
                { ...requested, personId: pendingId },
                // Refused before decisions were audited: only the stamp records it.
                { programId, personId: stampOnlyId, status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: new Date(), paymentPlanDeniedAt: new Date('2026-03-01T00:00:00Z') },
            ],
        });

        asBoard();
        expect((await ProgramApprove(post('/api/finance-ops/payment-plans', { programId, participantId: approvedId }))).status).toBe(200);
        expect((await ProgramRefuse(post('/api/finance-ops/payment-plans/refuse', { programId, participantId: refusedId }))).status).toBe(200);
        // A withdrawal audits the whole row, decision stamps included; it is not another decision.
        for (const participantId of [approvedId, refusedId]) {
            const req = new Request(`http://localhost/api/programs/${programId}/participants`, {
                method: 'DELETE',
                body: JSON.stringify({ participantId, mode: 'withdraw', reason: 'Family moved away' }),
            }) as unknown as NextRequest;
            expect((await ParticipantExit(req, { params: Promise.resolve({ id: String(programId) }) })).status).toBe(200);
        }
    });

    const mine = async () =>
        (await allPast<ProgramPastRow>(ProgramPast, '/api/finance-ops/payment-plans/past')).filter((r) => r.programId === programId);

    it('lists a refused request with who refused it', async () => {
        asFinance();
        const row = (await mine()).find((r) => r.personId === refusedId);
        expect(row).toMatchObject({ outcome: 'REFUSED', decidedByName: boardName, programName: `Program ${TAG}` });
        expect(row?.decidedAt).not.toBeNull();
    });

    it('lists an approved request with its approver', async () => {
        asBoard();
        const row = (await mine()).find((r) => r.personId === approvedId);
        expect(row).toMatchObject({ outcome: 'APPROVED', decidedByName: boardName });
    });

    it('shows a decision known only from its stamp, with no decider', async () => {
        asFinance();
        const row = (await mine()).find((r) => r.personId === stampOnlyId);
        expect(row).toMatchObject({ outcome: 'REFUSED', decidedByName: null, decidedAt: '2026-03-01T00:00:00.000Z' });
    });

    it('lists each decision once, though both places were later withdrawn', async () => {
        asFinance();
        const rows = await mine();
        expect(rows.filter((r) => r.personId === approvedId).map((r) => r.outcome)).toEqual(['APPROVED']);
        expect(rows.filter((r) => r.personId === refusedId).map((r) => r.outcome)).toEqual(['REFUSED']);
    });

    it('leaves the still-pending request out of Past and in the pending queue alone', async () => {
        asFinance();
        expect((await mine()).map((r) => r.personId).sort()).toEqual([approvedId, refusedId, stampOnlyId].sort());
        const pending: { ProgramParticipant: { programId: number; personId: number }[] } = await (await ProgramPending(get('/api/finance-ops/payment-plans'))).json();
        expect(pending.ProgramParticipant.filter((p) => p.programId === programId).map((p) => p.personId)).toEqual([pendingId]);
    });

    it('refuses a role outside the queue audience', async () => {
        asOther();
        expect((await ProgramPast(get('/api/finance-ops/payment-plans/past'))).status).toBe(403);
    });
});

describe('membership payment plans — Past', () => {
    let approvedProcess: number;
    let refusedProcess: number;
    let stampOnlyProcess: number;

    async function process(label: string, data: Record<string, unknown>) {
        const hh = await prisma.household.create({ data: { name: `${label} ${seq++} ${TAG}` } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE', isVolunteerFamily: false } });
        return (await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', bgClearedAt: new Date(), scholarshipRequestKind: 'SCHOLARSHIP', ...data },
        })).id;
    }

    beforeAll(async () => {
        approvedProcess = await process('Approved', { isPaymentPlanRequested: true });
        refusedProcess = await process('Refused', { isPaymentPlanRequested: true });
        // Approved before decisions were audited: the certified payment is the only record.
        stampOnlyProcess = await process('Stamped', { isPaymentPlanRequested: false, status: 'ACTIVE', manualPaymentById: boardId, paidAt: new Date('2026-02-01T00:00:00Z') });

        asBoard();
        expect((await MembershipApprove(post('/api/finance-ops/membership-payment-plans', { processId: approvedProcess, reason: 'Board approved scholarship' }))).status).toBe(200);
        expect((await MembershipRefuse(post('/api/finance-ops/membership-payment-plans/refuse', { processId: refusedProcess }))).status).toBe(200);
    });

    const mine = async () => {
        const ids = new Set([approvedProcess, refusedProcess, stampOnlyProcess]);
        return (await allPast<MembershipPastRow>(MembershipPast, '/api/finance-ops/membership-payment-plans/past')).filter((r) => ids.has(r.processId));
    };

    it('lists a refused request with who refused it', async () => {
        asFinance();
        expect((await mine()).find((r) => r.processId === refusedProcess)).toMatchObject({ outcome: 'REFUSED', decidedByName: boardName });
    });

    it('lists an approved request with its approver', async () => {
        asBoard();
        const row = (await mine()).find((r) => r.processId === approvedProcess);
        expect(row).toMatchObject({ outcome: 'APPROVED', decidedByName: boardName });
        expect(row?.householdName).toContain('Approved');
    });

    it('shows an approval known only from its certified payment', async () => {
        asFinance();
        expect((await mine()).find((r) => r.processId === stampOnlyProcess)).toMatchObject({ outcome: 'APPROVED', decidedByName: boardName, decidedAt: '2026-02-01T00:00:00.000Z' });
    });

    it('refuses a role outside the queue audience', async () => {
        asOther();
        expect((await MembershipPast(get('/api/finance-ops/membership-payment-plans/past'))).status).toBe(403);
    });
});
