/**
 * @jest-environment node
 */
/**
 * Unit tests for checkStarted.ts (prisma, settle, advance and notify mocked, no DB):
 *   - markCheckStarted: who may mark whom, the known-minor refusal, reuse versus
 *     create, a BLOCKED review left untouched, the requested household filled in,
 *     the one-time stamp and reviewer ping, and the settle + advance after.
 *   - checkStartedRows: the caller's own row always, a lead's household adults, and
 *     a state of only NEEDS_MARKING or NOTHING_TO_DO.
 */
import { checkStartedRows, markCheckStarted } from '@/lib/membership/checkStarted';
import { advanceExternalIfComplete } from '@/lib/membership/external';
import { notifyReviewers } from '@/lib/membership/review';
import { settleAfterEvent } from '@/lib/membership/settleHouseholdBg';
import { checkValidForApplication } from '@/lib/membership/checkStanding';

function mockMakeDb() {
    return {
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        orgMembershipProcess: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
        auditLog: { create: jest.fn() },
        $queryRaw: jest.fn(),
        $transaction: jest.fn(),
    };
}
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockMakeDb() }));
jest.mock('@/lib/membership/external', () => {
    const actual = jest.requireActual('@/lib/membership/external');
    return { ExternalError: actual.ExternalError, advanceExternalIfComplete: jest.fn() };
});
jest.mock('@/lib/membership/review', () => ({ notifyReviewers: jest.fn() }));
jest.mock('@/lib/membership/settleHouseholdBg', () => ({ settleAfterEvent: jest.fn() }));
jest.mock('@/lib/logger', () => ({ ...jest.requireActual('@/lib/logger'), logBackendError: jest.fn() }));
jest.mock('@/lib/membership/checkStanding', () => ({ checkValidForApplication: jest.fn() }));
jest.mock('@/lib/membership/background-check/manual-adapter', () => ({ backgroundCheckProvider: { getConsentDeepLink: jest.fn() } }));

const prisma = jest.requireMock<{ default: ReturnType<typeof mockMakeDb> }>('@/lib/prisma').default;
const person = prisma.person;
const process_ = prisma.orgMembershipProcess;
const auditCreate = prisma.auditLog.create;

const adult = { dateOfBirth: new Date('1980-01-01'), isDeclaredAdult: false };
const actor = (over: Record<string, unknown> = {}) => ({ id: 1, householdId: 10, isHouseholdLead: false, isSysadmin: false, isBoardMember: false, ...over });
const subject = (over: Record<string, unknown> = {}) => ({ id: 2, householdId: 10, ...adult, ...over });

/** The actor and subject rows markCheckStarted reads; one person when the ids match. */
function given(a: { id: number }, s: { id: number }) {
    const self = a.id === s.id ? { ...s, ...a } : null;
    person.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => self ?? (where.id === a.id ? a : s));
}

beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    process_.findMany.mockResolvedValue([]);
    process_.create.mockResolvedValue({ id: 70 });
    process_.updateMany.mockResolvedValue({ count: 1 });
    process_.findFirst.mockResolvedValue({ id: 40 });
});

describe('markCheckStarted — who may mark whom', () => {
    it('a person marks their own check', async () => {
        given(actor({ id: 2 }), subject());
        await expect(markCheckStarted(2, 2)).resolves.toEqual({ processId: 70 });
    });

    it("a household lead marks another adult's in their household", async () => {
        given(actor({ isHouseholdLead: true }), subject());
        await expect(markCheckStarted(2, 1)).resolves.toEqual({ processId: 70 });
    });

    it('a lead of another household is refused, writing nothing', async () => {
        given(actor({ isHouseholdLead: true, householdId: 11 }), subject());
        await expect(markCheckStarted(2, 1)).rejects.toMatchObject({ code: 'not_lead' });
        expect(process_.create).not.toHaveBeenCalled();
    });

    it('a non-lead in the same household is refused', async () => {
        given(actor(), subject());
        await expect(markCheckStarted(2, 1)).rejects.toMatchObject({ code: 'not_lead' });
    });

    it.each([['isBoardMember'], ['isSysadmin']])('%s marks anyone, with no own-household guard', async (role) => {
        given(actor({ [role]: true }), subject());
        await expect(markCheckStarted(2, 1)).resolves.toEqual({ processId: 70 });
    });

    it('a known minor is refused', async () => {
        given(actor({ id: 2 }), subject({ dateOfBirth: new Date(Date.now() - 10 * 365 * 86400_000) }));
        await expect(markCheckStarted(2, 2)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a person of unknown age, a cleared person and one with no household are accepted', async () => {
        given(actor({ id: 2 }), subject({ dateOfBirth: null }));
        await expect(markCheckStarted(2, 2)).resolves.toEqual({ processId: 70 });
        given(actor({ id: 2 }), subject({ lastBackgroundCheck: new Date() }));
        await expect(markCheckStarted(2, 2)).resolves.toEqual({ processId: 70 });
        given(actor({ id: 2, householdId: null }), subject({ householdId: null }));
        await expect(markCheckStarted(2, 2)).resolves.toEqual({ processId: 70 });
    });

    it('an unknown subject is not_lead to a family caller, so the id stays unconfirmed', async () => {
        person.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => (where.id === 1 ? actor({ isHouseholdLead: true }) : null));
        await expect(markCheckStarted(999, 1)).rejects.toMatchObject({ code: 'not_lead' });
    });

    it('an unknown subject is not_found to the Board', async () => {
        person.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => (where.id === 1 ? actor({ isBoardMember: true }) : null));
        await expect(markCheckStarted(999, 1)).rejects.toMatchObject({ code: 'not_found' });
    });
});

describe('markCheckStarted — the review', () => {
    beforeEach(() => given(actor({ id: 2 }), subject()));

    it('creates a review naming the person, requested for their household, with one audit row naming the actor', async () => {
        await markCheckStarted(2, 2);
        expect(process_.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ kind: 'PERSON_BG', status: 'PENDING_BG_REVIEW', subjectPersonId: 2, requestedForHouseholdId: 10, bgConsentAt: expect.any(Date) }),
        });
        expect(auditCreate).toHaveBeenCalledTimes(1);
        expect(auditCreate.mock.calls[0][0].data).toMatchObject({ actorId: 2, action: 'CREATE', affectedEntityId: 70, newData: expect.objectContaining({ checkStarted: true }) });
        expect(notifyReviewers).toHaveBeenCalledTimes(1);
        expect(settleAfterEvent).toHaveBeenCalledWith(10, expect.any(String), {}, expect.anything());
        expect(advanceExternalIfComplete).toHaveBeenCalledWith(40);
    });


    it('takes the Person row lock before reading', async () => {
        await markCheckStarted(2, 2);
        expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('reuses an open review, stamps it once and fills an empty requested household', async () => {
        process_.findMany.mockResolvedValue([{ id: 55, status: 'PENDING_BG_REVIEW', bgConsentAt: null, requestedForHouseholdId: null }]);
        await expect(markCheckStarted(2, 2)).resolves.toEqual({ processId: 55 });
        expect(process_.create).not.toHaveBeenCalled();
        expect(process_.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ id: 55, bgConsentAt: null, status: 'PENDING_BG_REVIEW' }),
            data: { bgConsentAt: expect.any(Date), requestedForHouseholdId: 10 },
        });
        expect(auditCreate.mock.calls[0][0].data.newData).toEqual({ checkStarted: true, requestedForHouseholdId: 10 });
        expect(notifyReviewers).toHaveBeenCalledTimes(1);
    });

    it('a second mark writes no audit row and pings nobody', async () => {
        process_.findMany.mockResolvedValue([{ id: 55, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date(), requestedForHouseholdId: 10 }]);
        process_.updateMany.mockResolvedValue({ count: 0 });
        await markCheckStarted(2, 2);
        expect(auditCreate).not.toHaveBeenCalled();
        expect(notifyReviewers).not.toHaveBeenCalled();
    });

    it('leaves a BLOCKED review as it is: no review, no fill, no stamp, no audit, no ping, no settle', async () => {
        process_.findMany.mockResolvedValue([{ id: 56, status: 'BLOCKED', bgConsentAt: new Date(), requestedForHouseholdId: null }]);
        await expect(markCheckStarted(2, 2)).resolves.toEqual({ processId: 56 });
        expect(process_.create).not.toHaveBeenCalled();
        expect(process_.updateMany).not.toHaveBeenCalled();
        expect(auditCreate).not.toHaveBeenCalled();
        expect(notifyReviewers).not.toHaveBeenCalled();
        expect(settleAfterEvent).not.toHaveBeenCalled();
        expect(advanceExternalIfComplete).not.toHaveBeenCalled();
    });

    it('a person with no household is marked but nothing is settled', async () => {
        given(actor({ id: 2, householdId: null }), subject({ householdId: null }));
        await markCheckStarted(2, 2);
        expect(settleAfterEvent).not.toHaveBeenCalled();
        expect(advanceExternalIfComplete).not.toHaveBeenCalled();
    });
});

describe('checkStartedRows', () => {
    const me = { id: 1, name: 'Me', householdId: 10, isHouseholdLead: true, ...adult, lastBackgroundCheck: null };

    beforeEach(() => jest.mocked(checkValidForApplication).mockResolvedValue(new Date('2026-01-01')));

    it("returns a lead's own row and each other non-minor member, with only personId, name and state", async () => {
        person.findUnique.mockResolvedValue(me);
        person.findMany.mockResolvedValue([
            { id: 2, name: 'Started', ...adult, lastBackgroundCheck: null },
            { id: 3, name: 'Cleared', ...adult, lastBackgroundCheck: new Date('2026-06-01') },
            { id: 4, name: 'Unknown age', dateOfBirth: null, isDeclaredAdult: false, lastBackgroundCheck: null },
            { id: 5, name: 'Child', dateOfBirth: new Date(Date.now() - 5 * 365 * 86400_000), isDeclaredAdult: false, lastBackgroundCheck: null },
        ]);
        process_.findMany.mockResolvedValue([{ subjectPersonId: 2 }]);

        await expect(checkStartedRows(1)).resolves.toEqual([
            { personId: 1, name: 'Me', state: 'NEEDS_MARKING' },
            { personId: 2, name: 'Started', state: 'NOTHING_TO_DO' },
            { personId: 3, name: 'Cleared', state: 'NOTHING_TO_DO' },
            { personId: 4, name: 'Unknown age', state: 'NEEDS_MARKING' },
        ]);
    });

    it('a non-lead gets their own row only', async () => {
        person.findUnique.mockResolvedValue({ ...me, isHouseholdLead: false });
        await expect(checkStartedRows(1)).resolves.toEqual([{ personId: 1, name: 'Me', state: 'NEEDS_MARKING' }]);
        expect(person.findMany).not.toHaveBeenCalled();
    });

    it("a known minor's own row has nothing to do", async () => {
        person.findUnique.mockResolvedValue({ ...me, isHouseholdLead: false, dateOfBirth: new Date(Date.now() - 12 * 365 * 86400_000) });
        await expect(checkStartedRows(1)).resolves.toEqual([{ personId: 1, name: 'Me', state: 'NOTHING_TO_DO' }]);
    });

    it("measures against the year of the household's open application", async () => {
        person.findUnique.mockResolvedValue({ ...me, isHouseholdLead: false });
        const app = { appliesToYear: null, createdAt: new Date('2026-07-15') };
        process_.findFirst.mockResolvedValue(app);
        await checkStartedRows(1);
        expect(checkValidForApplication).toHaveBeenCalledWith(app);
    });

    it('with no recheck policy no clearance counts, so a check needs marking', async () => {
        jest.mocked(checkValidForApplication).mockResolvedValue(null);
        person.findUnique.mockResolvedValue({ ...me, isHouseholdLead: false, lastBackgroundCheck: new Date() });
        await expect(checkStartedRows(1)).resolves.toEqual([{ personId: 1, name: 'Me', state: 'NEEDS_MARKING' }]);
    });
});
