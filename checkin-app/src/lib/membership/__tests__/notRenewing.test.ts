/**
 * @jest-environment node
 */
import { clearNotRenewing, isNotRenewingRenewal, markNotRenewing, noteStands, notRenewingTargetYear } from '@/lib/membership/notRenewing';
import { ArchivedHouseholdError } from '@/lib/household/archiveGuard';

const mockTx = {
    $queryRaw: jest.fn(),
    person: { findUnique: jest.fn() },
    orgMembershipProcess: { findFirst: jest.fn() },
    orgMembership: { updateMany: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    auditLog: { create: jest.fn() },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        household: { findUnique: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(mockTx)),
    },
}));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn() }));
jest.mock('@/lib/household/archiveGuard', () => ({
    ...jest.requireActual('@/lib/household/archiveGuard'),
    lockLiveHouseholds: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prisma = require('@/lib/prisma').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emailBoardMembers } = require('@/lib/emailRecipients');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { lockLiveHouseholds } = require('@/lib/household/archiveGuard');

const BOUNDARY = new Date(Date.UTC(2020, 8, 1)); // Sep 1; the renewal window opens Jul 1
const DAY_BEFORE_WINDOW = new Date(Date.UTC(2026, 5, 30, 12));
const WINDOW_OPENS = new Date(Date.UTC(2026, 6, 1, 0));
const ADULT = new Date(Date.UTC(1980, 0, 1));
const LEAD = { name: 'Alex Rivera', householdId: 7, isHouseholdLead: true, dateOfBirth: ADULT };

beforeEach(() => {
    jest.clearAllMocks();
    prisma.person.findUnique.mockResolvedValue(LEAD);
    mockTx.person.findUnique.mockResolvedValue(LEAD);
    prisma.household.findUnique.mockResolvedValue({ name: 'Rivera' });
    prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
    mockTx.$queryRaw.mockResolvedValue([{ id: 9, status: 'ACTIVE' }]);
    mockTx.orgMembershipProcess.findFirst.mockResolvedValue(null);
    mockTx.orgMembership.updateMany.mockResolvedValue({ count: 1 });
    mockTx.orgMembership.findUnique.mockResolvedValue({ id: 9 });
    mockTx.orgMembership.findUniqueOrThrow.mockResolvedValue({ id: 9, householdId: 7, notRenewingYear: 2026 });
});

describe('notRenewingTargetYear', () => {
    it('is the year after the live one the day before the window opens', () => {
        expect(notRenewingTargetYear(BOUNDARY, DAY_BEFORE_WINDOW)).toBe(2026);
    });

    it('is the live year, the coming one, from the day the window opens', () => {
        expect(notRenewingTargetYear(BOUNDARY, WINDOW_OPENS)).toBe(2026);
        expect(notRenewingTargetYear(BOUNDARY, new Date(Date.UTC(2026, 8, 2)))).toBe(2027);
    });

    it('is null with no boundary', () => {
        expect(notRenewingTargetYear(null, WINDOW_OPENS)).toBeNull();
    });
});

describe('isNotRenewingRenewal', () => {
    const renewal = { kind: 'RENEWAL', createdAt: new Date(Date.UTC(2026, 6, 2)) };

    it('flags a renewal opened for the noted year, before or after the boundary passes', () => {
        expect(isNotRenewingRenewal(renewal, 2026, BOUNDARY)).toBe(true);
    });

    it('ignores a note for another year, an old renewal, and a non-renewal', () => {
        expect(isNotRenewingRenewal(renewal, 2025, BOUNDARY)).toBe(false);
        expect(isNotRenewingRenewal({ ...renewal, createdAt: new Date(Date.UTC(2025, 6, 2)) }, 2026, BOUNDARY)).toBe(false);
        expect(isNotRenewingRenewal({ ...renewal, kind: 'INITIAL' }, 2026, BOUNDARY)).toBe(false);
        expect(isNotRenewingRenewal(renewal, null, BOUNDARY)).toBe(false);
    });
});

describe('noteStands', () => {
    it('holds for the live year and later, and lapses once its year has passed', () => {
        const afterBoundary = new Date(Date.UTC(2026, 8, 2)); // live year 2026
        expect(noteStands(2026, BOUNDARY, afterBoundary)).toBe(true);
        expect(noteStands(2027, BOUNDARY, afterBoundary)).toBe(true);
        expect(noteStands(2025, BOUNDARY, afterBoundary)).toBe(false);
        expect(noteStands(null, BOUNDARY, afterBoundary)).toBe(false);
        expect(noteStands(2026, null, afterBoundary)).toBe(false);
    });
});

describe('markNotRenewing', () => {
    it('sets the noted year with an audit row, then emails the Board', async () => {
        await expect(markNotRenewing(42, WINDOW_OPENS)).resolves.toEqual({ id: 9, householdId: 7, notRenewingYear: 2026 });
        expect(mockTx.orgMembership.updateMany).toHaveBeenCalledWith({
            where: { id: 9, OR: [{ notRenewingYear: null }, { notRenewingYear: { not: 2026 } }] },
            data: { notRenewingYear: 2026 },
        });
        expect(lockLiveHouseholds).toHaveBeenCalledWith(mockTx, [7]);
        expect(mockTx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ actorId: 42, tableName: 'OrgMembership', affectedEntityId: 9, newData: { notRenewingYear: 2026 } }),
        });
        expect(emailBoardMembers).toHaveBeenCalledWith('board.notRenewing', expect.objectContaining({ householdName: 'Rivera', personName: 'Alex Rivera', year: '2026-2027' }), expect.any(String));
    });

    it('a repeat is a no-op success: no audit row, no email', async () => {
        mockTx.orgMembership.updateMany.mockResolvedValue({ count: 0 });
        await expect(markNotRenewing(42, WINDOW_OPENS)).resolves.toMatchObject({ notRenewingYear: 2026 });
        expect(mockTx.auditLog.create).not.toHaveBeenCalled();
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it.each([
        ['a non-lead', { ...LEAD, isHouseholdLead: false }],
        ['a youth lead', { ...LEAD, dateOfBirth: new Date(Date.UTC(2015, 0, 1)) }],
        ['someone in no household', null],
    ])('refuses %s', async (_label, person) => {
        prisma.person.findUnique.mockResolvedValue(person);
        await expect(markNotRenewing(42, WINDOW_OPENS)).rejects.toMatchObject({ status: 403, code: 'not_lead' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a membership that is not ACTIVE', async () => {
        mockTx.$queryRaw.mockResolvedValue([{ id: 9, status: 'LAPSED' }]);
        await expect(markNotRenewing(42, WINDOW_OPENS)).rejects.toMatchObject({ status: 409, code: 'not_active' });
        expect(mockTx.orgMembership.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an archived household', async () => {
        lockLiveHouseholds.mockRejectedValueOnce(new ArchivedHouseholdError());
        await expect(markNotRenewing(42, WINDOW_OPENS)).rejects.toBeInstanceOf(ArchivedHouseholdError);
        expect(mockTx.orgMembership.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a household whose renewal is past PENDING_RENEWAL', async () => {
        mockTx.orgMembershipProcess.findFirst.mockResolvedValueOnce({ id: 3 });
        await expect(markNotRenewing(42, WINDOW_OPENS)).rejects.toMatchObject({ status: 409, code: 'renewal_underway' });
        expect(mockTx.orgMembershipProcess.findFirst.mock.calls[0][0].where.status.in).not.toContain('PENDING_RENEWAL');
        expect(mockTx.orgMembership.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a lead demoted or moved after the first read', async () => {
        mockTx.person.findUnique.mockResolvedValueOnce({ ...LEAD, isHouseholdLead: false });
        await expect(markNotRenewing(42, WINDOW_OPENS)).rejects.toMatchObject({ code: 'not_lead' });
        mockTx.person.findUnique.mockResolvedValueOnce({ ...LEAD, householdId: 8 });
        await expect(markNotRenewing(42, WINDOW_OPENS)).rejects.toMatchObject({ code: 'not_lead' });
        expect(mockTx.orgMembership.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a household that has already paid for the noted year', async () => {
        mockTx.orgMembershipProcess.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 3 });
        await expect(markNotRenewing(42, WINDOW_OPENS)).rejects.toMatchObject({ status: 409, code: 'already_renewed' });
        expect(mockTx.orgMembership.updateMany).not.toHaveBeenCalled();
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it('refuses with no membership year set', async () => {
        prisma.boardSettings.findUnique.mockResolvedValue(null);
        await expect(markNotRenewing(42, WINDOW_OPENS)).rejects.toMatchObject({ status: 409, code: 'no_boundary' });
    });
});

describe('clearNotRenewing', () => {
    it('clears the note with an audit row and sends nothing', async () => {
        mockTx.orgMembership.findUniqueOrThrow.mockResolvedValue({ id: 9, householdId: 7, notRenewingYear: null });
        await expect(clearNotRenewing(42)).resolves.toMatchObject({ notRenewingYear: null });
        expect(mockTx.orgMembership.updateMany).toHaveBeenCalledWith({
            where: { id: 9, notRenewingYear: { not: null } },
            data: { notRenewingYear: null },
        });
        expect(mockTx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ affectedEntityId: 9, newData: { notRenewingYear: null } }),
        });
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    it('a repeat is a no-op success', async () => {
        mockTx.orgMembership.updateMany.mockResolvedValue({ count: 0 });
        await expect(clearNotRenewing(42)).resolves.toBeDefined();
        expect(mockTx.auditLog.create).not.toHaveBeenCalled();
    });

    it('refuses a non-lead', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...LEAD, isHouseholdLead: false });
        await expect(clearNotRenewing(42)).rejects.toMatchObject({ code: 'not_lead' });
    });

    it('refuses a household with no membership, in its own words', async () => {
        mockTx.$queryRaw.mockResolvedValueOnce([]);
        await expect(clearNotRenewing(42)).rejects.toMatchObject({ status: 409, code: 'no_membership', message: 'Your household has no membership to change.' });
    });

    it('refuses an archived household', async () => {
        lockLiveHouseholds.mockRejectedValueOnce(new ArchivedHouseholdError());
        await expect(clearNotRenewing(42)).rejects.toBeInstanceOf(ArchivedHouseholdError);
        expect(mockTx.orgMembership.updateMany).not.toHaveBeenCalled();
    });
});
