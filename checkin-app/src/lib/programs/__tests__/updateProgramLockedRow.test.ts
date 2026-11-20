/**
 * @jest-environment node
 *
 * updateProgram reads the program row under its lock. The Shopify stock delta,
 * the price sync, the re-arm and its notice all go by that row, not by the
 * caller's earlier read, which a concurrent edit may have made stale.
 */
import type { Program } from '@/generated/prisma/client';
import { updateProgram } from '@/lib/programs/update';

jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
jest.mock('@/lib/programAnnounce', () => ({ maybeAnnounceOnOpen: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/shopify/stock', () => ({
    STOCK_BOOKKEEPING_RESET: {},
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
    setProgramInventory: jest.fn().mockResolvedValue(true),
    syncProgramPrice: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/program/capacity', () => ({ countStockTakenSeats: jest.fn().mockResolvedValue(0) }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn() }));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/household/archiveGuard', () => ({ lockLiveHouseholdsOf: jest.fn().mockResolvedValue(undefined) }));

const program = {
    id: 5, name: 'Robotics', leadMentorId: 7, phase: 'UPCOMING', enrollmentStatus: 'OPEN',
    startAt: new Date('2099-09-01'), endAt: new Date('2099-12-01'), appliesToYear: 2099,
    offSaleAt: null, saleEndedAt: null, productHiddenAt: null,
    minAge: null, maxAge: null, maxParticipants: 10,
    orgMemberOnly: false, publiclyVisible: false,
    orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000, shopifyVariantId: 'gid://variant/1',
} as unknown as Program;
const ended = {
    ...program, enrollmentStatus: 'CLOSED', offSaleAt: new Date('2026-01-01'), saleEndedAt: new Date('2026-01-01'),
} as unknown as Program;

let rowAtWrite: Program = program;
const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    program: {
        findUnique: jest.fn(() => Promise.resolve(rowAtWrite)),
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
        programParticipant: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
        person: { findUnique: jest.fn().mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: true, householdId: 3 }) },
        event: { count: jest.fn().mockResolvedValue(1) },
    },
}));

const stock = jest.requireMock('@/lib/shopify/stock');
const actor = { id: 1, isSysadmin: true, isBoardMember: true };

beforeEach(() => {
    jest.clearAllMocks();
    rowAtWrite = program;
});

describe('a cap edit after a concurrent cap edit', () => {
    it('moves stock by the change from the locked cap', async () => {
        rowAtWrite = { ...program, maxParticipants: 12 } as Program;
        await updateProgram(program, { maxParticipants: 15 }, actor);
        expect(stock.adjustProgramInventory).toHaveBeenCalledWith(
            expect.objectContaining({ maxParticipants: 15 }), 3, 'capacity-edit', { inRequest: true });
    });

    it('moves no stock when this save leaves the locked cap as it is', async () => {
        rowAtWrite = { ...program, maxParticipants: 12 } as Program;
        await updateProgram(program, { maxParticipants: 12 }, actor);
        expect(stock.adjustProgramInventory).not.toHaveBeenCalled();
    });
});

describe('a price save after a concurrent price edit', () => {
    it('pushes the price when it differs from the locked row', async () => {
        rowAtWrite = { ...program, nonOrgMemberPriceCents: 6000 } as Program;
        await updateProgram(program, { nonMemberPrice: '50.00' }, actor);
        expect(stock.syncProgramPrice).toHaveBeenCalledWith(expect.anything(), 5000);
    });
});

describe('re-arming after a concurrent change to the sale', () => {
    it('refuses when the sale ended after the caller read the program', async () => {
        rowAtWrite = ended;
        const result = await updateProgram(program, { offSaleAt: '2099-06-01' }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('says the product stays hidden when the locked row was hidden', async () => {
        rowAtWrite = { ...ended, productHiddenAt: new Date('2026-01-02') } as Program;
        const result = await updateProgram(ended, { offSaleAt: '2099-06-01' }, actor);
        expect(result).toMatchObject({ ok: true, notice: expect.stringContaining('stays hidden') });
    });
});

describe('re-arming after a concurrent end of the program', () => {
    it('refuses when the locked row has finished', async () => {
        const running = { ...ended, phase: 'RUNNING' } as Program;
        rowAtWrite = { ...ended, phase: 'FINISHED' } as Program;
        const result = await updateProgram(running, { offSaleAt: '2099-06-01' }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });
});

describe('a save after a concurrent change of Shopify variant', () => {
    it('refuses instead of writing the old variant back', async () => {
        rowAtWrite = { ...program, shopifyVariantId: 'gid://variant/2' } as Program;
        const result = await updateProgram(program, { shopifyVariantId: 'gid://variant/1' }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });
});

describe('a program stored with its start after its end', () => {
    const inverted = { ...program, startAt: new Date('2099-12-15'), endAt: new Date('2099-12-01') } as Program;

    it('still saves a field other than its dates', async () => {
        rowAtWrite = inverted;
        expect((await updateProgram(inverted, { announceOnOpen: true }, actor)).ok).toBe(true);
    });

    it('refuses a publish until its dates are fixed', async () => {
        const planning = { ...inverted, phase: 'PLANNING' } as Program;
        rowAtWrite = planning;
        expect(await updateProgram(planning, { phase: 'UPCOMING' }, actor)).toMatchObject({ ok: false, refusal: 'invalid' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('refuses a move to running until its dates are fixed', async () => {
        rowAtWrite = inverted;
        expect(await updateProgram(inverted, { phase: 'RUNNING' }, actor)).toMatchObject({ ok: false, refusal: 'invalid' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('still saves when the form resends the current phase', async () => {
        rowAtWrite = inverted;
        expect((await updateProgram(inverted, { phase: 'UPCOMING', announceOnOpen: true }, actor)).ok).toBe(true);
    });

    it('refuses a date change that leaves the range inverted', async () => {
        rowAtWrite = inverted;
        expect(await updateProgram(inverted, { endAt: '2099-12-10' }, actor)).toMatchObject({ ok: false, refusal: 'invalid' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });
});

describe('an age bound that is not a whole number', () => {
    it('is refused before any write', async () => {
        expect(await updateProgram(program, { minAge: '' as unknown as number }, actor)).toMatchObject({ ok: false, refusal: 'invalid' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });
});
