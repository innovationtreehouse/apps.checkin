/**
 * @jest-environment node
 *
 * updateProgram follows the sale machine (saleState TRANSITIONS): a program ends
 * only once nothing is on sale, and an ended program's sale is never re-armed.
 */
import type { Program } from '@/generated/prisma/client';
import { updateProgram } from '@/lib/programs/update';

jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
jest.mock('@/lib/programAnnounce', () => ({ maybeAnnounceOnOpen: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/shopify/stock', () => ({ STOCK_BOOKKEEPING_RESET: {} }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn() }));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/household/archiveGuard', () => ({ lockLiveHouseholdsOf: jest.fn().mockResolvedValue(undefined) }));

const program = {
    id: 5, name: 'Robotics', leadMentorId: 7, phase: 'RUNNING', enrollmentStatus: 'OPEN',
    startAt: new Date('2099-09-01'), endAt: new Date('2099-12-01'), appliesToYear: 2099,
    offSaleAt: null, saleEndedAt: null, productHiddenAt: null,
    minAge: null, maxAge: null, maxParticipants: 10,
    orgMemberOnly: false, publiclyVisible: false,
    orgMemberPriceCents: null, nonOrgMemberPriceCents: null, shopifyVariantId: null,
} as unknown as Program;
const ended = { ...program, enrollmentStatus: 'CLOSED', offSaleAt: new Date('2026-01-01'), saleEndedAt: new Date('2026-01-01') } as unknown as Program;

// The row as a concurrent edit left it, after the caller read `program`.
const rowAtWrite = program;

const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    program: {
        findUnique: jest.fn().mockResolvedValue(rowAtWrite),
        update: jest.fn(({ data }: { data: Partial<Program> }) => Promise.resolve({ ...rowAtWrite, ...data })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        $transaction: (fn: (t: unknown) => unknown) => fn(tx),
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        programParticipant: { findMany: jest.fn().mockResolvedValue([]) },
        person: { findUnique: jest.fn().mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: true, householdId: 3 }) },
    },
}));

const actor = { id: 1, isSysadmin: true, isBoardMember: true };

beforeEach(() => jest.clearAllMocks());

describe('ending a program', () => {
    it('refuses while it is still on sale', async () => {
        const result = await updateProgram(program, { phase: 'FINISHED' }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('allows it once enrollment is closed, including in the same save', async () => {
        expect((await updateProgram(program, { phase: 'FINISHED', enrollmentStatus: 'CLOSED' }, actor)).ok).toBe(true);
    });

    it('allows it once the sale has ended', async () => {
        tx.program.findUnique.mockResolvedValueOnce(ended);
        expect((await updateProgram(ended, { phase: 'FINISHED' }, actor)).ok).toBe(true);
    });
});

describe('re-arming an ended sale', () => {
    it('refuses for a finished program', async () => {
        const finished = { ...ended, phase: 'FINISHED' } as unknown as Program;
        const result = await updateProgram(finished, { offSaleAt: '2099-06-01' }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('allows it for a program that has not ended', async () => {
        tx.program.findUnique.mockResolvedValueOnce(ended);
        const result = await updateProgram(ended, { offSaleAt: '2099-06-01' }, actor);
        expect(result.ok).toBe(true);
        expect(tx.program.update.mock.calls[0][0].data).toMatchObject({ saleEndedAt: null });
    });
});
