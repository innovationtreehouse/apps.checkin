/**
 * @jest-environment node
 *
 * updateProgram follows the sale machine (saleState TRANSITIONS): a program ends
 * only once nothing is on sale, a lead ends it only on or after its end date, an
 * ended program stays ended, and its sale is never re-armed.
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
    programParticipant: { count: jest.fn().mockResolvedValue(0) },
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

beforeEach(() => {
    jest.clearAllMocks();
    tx.program.findUnique.mockReset().mockResolvedValue(rowAtWrite);
    tx.programParticipant.count.mockReset().mockResolvedValue(0);
});

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

const finished = { ...ended, phase: 'FINISHED' } as unknown as Program;
const lead = { id: 7, isSysadmin: false, isBoardMember: false };

describe('an ended program stays ended', () => {
    it.each(['RUNNING', 'PLANNING', 'UPCOMING'] as const)('refuses a move back to %s', async (phase) => {
        const result = await updateProgram(finished, { phase }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('refuses to open its enrollment', async () => {
        const result = await updateProgram(finished, { enrollmentStatus: 'OPEN' }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict', message: expect.stringContaining('ended') });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('still saves an edit that leaves its phase as it is', async () => {
        tx.program.findUnique.mockResolvedValueOnce(finished);
        expect((await updateProgram(finished, { phase: 'FINISHED', name: 'Robotics 2' }, actor)).ok).toBe(true);
    });
});

describe('races decided on the row read under the lock', () => {
    it('refuses opening enrollment when the Board ended the program after the caller read it', async () => {
        const closed = { ...program, enrollmentStatus: 'CLOSED' } as unknown as Program;
        tx.program.findUnique.mockResolvedValueOnce({ ...closed, phase: 'FINISHED' });
        const result = await updateProgram(closed, { enrollmentStatus: 'OPEN' }, lead);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('refuses a re-arm when the program ended after the caller read it', async () => {
        tx.program.findUnique.mockResolvedValueOnce(finished);
        const result = await updateProgram(ended, { offSaleAt: '2099-06-01' }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('refuses ending when a re-arm landed after the caller read it', async () => {
        tx.program.findUnique.mockResolvedValueOnce({ ...ended, saleEndedAt: null, offSaleAt: new Date('2099-06-01') });
        const result = await updateProgram(ended, { phase: 'FINISHED' }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('refuses a lead ending when the end date moved later after the caller read it', async () => {
        const due = { ...ended, startAt: new Date('2025-09-01'), endAt: new Date('2026-01-01') } as unknown as Program;
        tx.program.findUnique.mockResolvedValueOnce({ ...due, endAt: new Date('2099-12-01') });
        const result = await updateProgram(due, { phase: 'FINISHED' }, lead);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });
});

describe('who ends a program, and when', () => {
    it('refuses its lead before the end date, naming the Board', async () => {
        const result = await updateProgram(ended, { phase: 'FINISHED' }, lead);
        expect(result).toMatchObject({ ok: false, refusal: 'forbidden', message: expect.stringContaining('Only the Board') });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('lets its lead end it once the end date has come', async () => {
        const due = { ...ended, startAt: new Date('2025-09-01'), endAt: new Date('2026-01-01') } as unknown as Program;
        tx.program.findUnique.mockResolvedValueOnce(due);
        expect((await updateProgram(due, { phase: 'FINISHED' }, lead)).ok).toBe(true);
    });

    it('lets the Board end it before the end date', async () => {
        tx.program.findUnique.mockResolvedValueOnce(ended);
        expect((await updateProgram(ended, { phase: 'FINISHED' }, { id: 2, isSysadmin: false, isBoardMember: true })).ok).toBe(true);
    });
});

describe('a capacity cut', () => {
    it('counts the enrolled places under the Program lock and refuses a cut below them', async () => {
        tx.program.findUnique.mockResolvedValueOnce(program);
        tx.programParticipant.count.mockResolvedValueOnce(4);
        const result = await updateProgram(program, { maxParticipants: 3 }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'invalid', message: expect.stringContaining('current enrollment of 4') });
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.programParticipant.count.mock.invocationCallOrder[0]);
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('saves a cut that still holds everyone enrolled', async () => {
        tx.program.findUnique.mockResolvedValueOnce(program);
        tx.programParticipant.count.mockResolvedValueOnce(3);
        expect((await updateProgram(program, { maxParticipants: 3 }, actor)).ok).toBe(true);
    });
});
