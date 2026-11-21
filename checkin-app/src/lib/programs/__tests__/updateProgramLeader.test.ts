/**
 * @jest-environment node
 *
 * A program's leader is at least 23, in an ACTIVE household membership, and holds a
 * background-check clearance. A new assignment is checked; a leader in place stays.
 */
import type { Program } from '@/generated/prisma/client';
import { updateProgram } from '@/lib/programs/update';
import { programLeaderIneligibility } from '@/lib/programs/leaderEligibility';
import { isActiveOrgMember } from '@/lib/orgMembership';
import { checkValidFor, loadCheckReviews } from '@/lib/membership/checkStanding';

jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
jest.mock('@/lib/programAnnounce', () => ({ maybeAnnounceOnOpen: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/shopify/stock', () => ({ STOCK_BOOKKEEPING_RESET: {} }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn() }));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/household/archiveGuard', () => ({ lockLiveHouseholdsOf: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/orgMembership', () => ({ isActiveOrgMember: jest.fn() }));
jest.mock('@/lib/membership/checkStanding', () => ({
    ...jest.requireActual('@/lib/membership/checkStanding'),
    checkValidFor: jest.fn(),
    loadCheckReviews: jest.fn(),
}));

const program = {
    id: 5, name: 'Robotics', leadMentorId: 7, phase: 'PLANNING', enrollmentStatus: 'CLOSED',
    startAt: new Date('2099-09-01'), endAt: new Date('2099-12-01'), appliesToYear: 2099,
    offSaleAt: null, saleEndedAt: null, productHiddenAt: null,
    minAge: null, maxAge: null, maxParticipants: 10,
    orgMemberOnly: false, publiclyVisible: false,
    orgMemberPriceCents: null, nonOrgMemberPriceCents: null, shopifyVariantId: null,
} as unknown as Program;

const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    program: {
        findUnique: jest.fn().mockResolvedValue(program),
        update: jest.fn(({ data }: { data: Partial<Program> }) => Promise.resolve({ ...program, ...data })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
};

const threshold = new Date('2099-01-01');
const fresh = { dateOfBirth: null, isDeclaredAdult: true, householdId: 3, lastBackgroundCheck: new Date('2099-06-01') };
const mockPerson = jest.fn();
const mockRefusalAudit = jest.fn().mockResolvedValue({});

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        $transaction: (fn: (t: unknown) => unknown) => fn(tx),
        programParticipant: { findMany: jest.fn().mockResolvedValue([]) },
        person: { findUnique: (...a: unknown[]) => mockPerson(...a) },
        auditLog: { create: (...a: unknown[]) => mockRefusalAudit(...a) },
    },
}));

const board = { id: 1, isSysadmin: false, isBoardMember: true };

beforeEach(() => {
    jest.clearAllMocks();
    mockPerson.mockResolvedValue(fresh);
    (isActiveOrgMember as jest.Mock).mockResolvedValue(true);
    (checkValidFor as jest.Mock).mockResolvedValue(threshold);
    (loadCheckReviews as jest.Mock).mockImplementation(async (_db: unknown, ids: number[]) => new Map(ids.map((id) => [id, []])));
});

describe('programLeaderIneligibility', () => {
    it('admits an ACTIVE member with a clearance inside the window', async () => {
        expect(await programLeaderIneligibility(9, fresh, 2026)).toBeNull();
    });

    it('refuses someone outside an ACTIVE household membership', async () => {
        (isActiveOrgMember as jest.Mock).mockResolvedValue(false);
        expect(await programLeaderIneligibility(9, fresh, 2026)).toMatch(/active Treehouse Membership/);
    });

    it('refuses a clearance older than the window, or none', async () => {
        expect(await programLeaderIneligibility(9, { lastBackgroundCheck: new Date('2098-01-01') }, 2026)).toMatch(/background-check clearance/);
        expect(await programLeaderIneligibility(9, { lastBackgroundCheck: null }, 2026)).toMatch(/background-check clearance/);
    });

    it('refuses a disputed check, however recent the clearance', async () => {
        (loadCheckReviews as jest.Mock).mockResolvedValue(new Map([[9, [{ id: 1, status: 'BLOCKED', bgConsentAt: true, sentBack: false }]]]));
        expect(await programLeaderIneligibility(9, fresh, 2026)).toMatch(/background-check clearance/);
    });

    it('refuses everyone while the Board has set no recheck window', async () => {
        (checkValidFor as jest.Mock).mockResolvedValue(null);
        expect(await programLeaderIneligibility(9, fresh, 2026)).toMatch(/Board must set the background-check interval/);
    });
});

describe('assigning a leader on edit', () => {
    it('refuses a new leader who is not a member, saving nothing', async () => {
        (isActiveOrgMember as jest.Mock).mockResolvedValue(false);
        const result = await updateProgram(program, { leadMentorId: 9 }, board);
        expect(result).toMatchObject({ ok: false, refusal: 'invalid', message: expect.stringMatching(/active Treehouse Membership/) });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('keeps the leader already in place, unchecked, when the form resends them', async () => {
        (isActiveOrgMember as jest.Mock).mockResolvedValue(false);
        expect((await updateProgram(program, { leadMentorId: 7, name: 'Robotics 2' }, board)).ok).toBe(true);
        expect(isActiveOrgMember).not.toHaveBeenCalled();
    });

    it("measures a new leader's clearance at the start of the program's membership year", async () => {
        await updateProgram(program, { leadMentorId: 9 }, board);
        expect(checkValidFor).toHaveBeenCalledWith(2099);
    });

    it('saves a new leader who meets every requirement', async () => {
        expect((await updateProgram(program, { leadMentorId: 9 }, board)).ok).toBe(true);
        expect(tx.program.update.mock.calls[0][0].data).toMatchObject({ leadMentorId: 9 });
    });
});

describe('naming oneself the leader', () => {
    it('is refused, and the refused attempt is audited', async () => {
        const result = await updateProgram(program, { leadMentorId: board.id }, board);
        expect(result).toMatchObject({ ok: false, refusal: 'forbidden' });
        expect(tx.program.update).not.toHaveBeenCalled();
        expect(mockRefusalAudit).toHaveBeenCalledWith({
            data: expect.objectContaining({
                actorId: board.id, affectedEntityId: board.id, action: 'EDIT', tableName: 'SelfGrantRefusal',
                newData: expect.objectContaining({ table: 'Program', attempted: { programId: 5, leadMentorId: board.id } }),
            }),
        });
    });
});
