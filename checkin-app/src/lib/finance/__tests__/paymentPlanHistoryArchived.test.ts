/**
 * @jest-environment node
 */
import { membershipPaymentPlanHistory, programPaymentPlanHistory } from '../paymentPlanHistory';
import { archivedParam } from '../paymentPlanHistoryPage';

type Where = { id?: { in: number[] }; orgMembership?: unknown; household?: unknown };
type Args = { where: Where };

const db = {
    auditLog: { findMany: jest.fn() },
    orgMembershipProcess: { findMany: jest.fn() },
    programParticipant: { findMany: jest.fn() },
    person: { findMany: jest.fn() },
    program: { findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, model: string) => db[model as keyof typeof db] }) }));

// 26 membership decisions, one a day; process 1 is the newest and its household is archived.
const ARCHIVED_PROCESS = 1;
const membershipAudits = Array.from({ length: 26 }, (_, i) => ({
    id: i + 1, timestamp: new Date(Date.UTC(2026, 0, 30 - i)), actorId: 99, affectedEntityId: i + 1, newData: { paymentPlanApproved: true },
}));

beforeEach(() => {
    jest.clearAllMocks();
    db.auditLog.findMany.mockResolvedValue(membershipAudits);
    db.orgMembershipProcess.findMany.mockImplementation(async ({ where }: Args) => {
        if (where.orgMembership) return where.id?.in.includes(ARCHIVED_PROCESS) ? [{ id: ARCHIVED_PROCESS }] : [];
        if (where.id) return where.id.in.map((id) => ({ id, orgMembership: { household: { id, name: `Household ${id}` } } }));
        return [];
    });
    db.person.findMany.mockResolvedValue([]);
    db.programParticipant.findMany.mockResolvedValue([]);
    db.program.findMany.mockResolvedValue([]);
});

describe('membershipPaymentPlanHistory and archived households', () => {
    it('hides an archived household decision by default, and pages past it', async () => {
        const first = await membershipPaymentPlanHistory(0, false);
        expect(first).toHaveLength(25);
        expect(first.map((r) => r.processId)).not.toContain(ARCHIVED_PROCESS);
        expect(await membershipPaymentPlanHistory(1, false)).toHaveLength(0);
    });

    it('shows it when asked, and the extra row moves to the next page', async () => {
        const first = await membershipPaymentPlanHistory(0, true);
        expect(first[0].processId).toBe(ARCHIVED_PROCESS);
        expect(await membershipPaymentPlanHistory(1, true)).toHaveLength(1);
    });
});

describe('programPaymentPlanHistory and archived households', () => {
    beforeEach(() => {
        db.auditLog.findMany.mockResolvedValue([]);
        db.programParticipant.findMany.mockResolvedValue([
            { programId: 3, personId: 1, wasOrgMemberAtApproval: true, paymentPlanDeniedAt: null, seatTakenWithoutSaleAt: new Date('2026-02-02') },
            { programId: 3, personId: 2, wasOrgMemberAtApproval: null, paymentPlanDeniedAt: new Date('2026-02-01'), seatTakenWithoutSaleAt: null },
        ]);
        db.person.findMany.mockImplementation(async ({ where }: Args) =>
            where.household ? [{ id: 1 }] : (where.id?.in ?? []).map((id) => ({ id, name: `Person ${id}`, email: null })),
        );
    });

    it('hides a decision for a person in an archived household by default', async () => {
        expect((await programPaymentPlanHistory(0, false)).map((r) => r.personId)).toEqual([2]);
    });

    it('shows it when asked', async () => {
        expect((await programPaymentPlanHistory(0, true)).map((r) => r.personId)).toEqual([1, 2]);
    });
});

describe('archivedParam', () => {
    const at = (q: string) => archivedParam(new Request(`http://localhost/x${q}`));
    it('is on only for archived=1', () => {
        expect(at('?archived=1')).toBe(true);
        expect(at('')).toBe(false);
        expect(at('?archived=true')).toBe(false);
    });
});
