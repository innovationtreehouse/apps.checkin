/**
 * @jest-environment node
 *
 * updateProgram: the name is checked and trimmed, and the audit's "before" copy
 * is read on the transaction client that makes the write.
 */
import type { Program } from '@/generated/prisma/client';
import { updateProgram } from '@/lib/programs/update';

// A new leader here meets the membership and clearance requirements; leaderEligibility has its own tests.
jest.mock('@/lib/programs/leaderEligibility', () => ({ ...jest.requireActual('@/lib/programs/leaderEligibility'), programLeaderIneligibility: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
jest.mock('@/lib/programAnnounce', () => ({ maybeAnnounceOnOpen: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/shopify/stock', () => ({ STOCK_BOOKKEEPING_RESET: {} }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn() }));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/household/archiveGuard', () => ({ lockLiveHouseholdsOf: jest.fn().mockResolvedValue(undefined) }));

const program = {
    id: 5, name: 'Robotics', leadMentorId: 7, phase: 'PLANNING', enrollmentStatus: 'CLOSED',
    startAt: new Date('2026-09-01'), endAt: new Date('2026-12-01'), appliesToYear: 2026,
    offSaleAt: null, saleEndedAt: null, productHiddenAt: null,
    minAge: null, maxAge: null, maxParticipants: 10,
    orgMemberOnly: false, publiclyVisible: false,
    orgMemberPriceCents: null, nonOrgMemberPriceCents: null, shopifyVariantId: null,
} as unknown as Program;

// The row as a concurrent edit left it, after the caller read `program`.
const rowAtWrite = { ...program, name: 'Robotics (renamed meanwhile)' };

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
        person: { findUnique: jest.fn().mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: true, householdId: 3, email: 'lead@example.com' }) },
    },
}));

const actor = { id: 1, isSysadmin: true, isBoardMember: true };

beforeEach(() => jest.clearAllMocks());

describe('updateProgram name', () => {
    it.each([
        ['a number', 123],
        ['an object', { first: 'x' }],
        ['whitespace only', '   '],
        ['251 characters', 'a'.repeat(251)],
    ])('refuses %s', async (_label, name) => {
        const result = await updateProgram(program, { name }, actor);
        expect(result).toMatchObject({ ok: false, refusal: 'invalid' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('accepts 250 characters', async () => {
        const name = 'a'.repeat(250);
        const result = await updateProgram(program, { name }, actor);
        expect(result.ok).toBe(true);
        expect(tx.program.update.mock.calls[0][0].data.name).toBe(name);
    });

    it('saves the trimmed name', async () => {
        await updateProgram(program, { name: '  Woodshop  ' }, actor);
        expect(tx.program.update.mock.calls[0][0].data.name).toBe('Woodshop');
    });

    it('writes the name key with the name', async () => {
        await updateProgram(program, { name: '  WoodShop  ' }, actor);
        expect(tx.program.update.mock.calls[0][0].data).toMatchObject({ name: 'WoodShop', nameKey: 'woodshop' });
    });

    it('refuses a rename into a name its membership year already has as a conflict', async () => {
        const taken = { code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { fields: ['"nameKey"', '"appliesToYear"'] } } } } };
        tx.program.update.mockRejectedValueOnce(taken);
        const result = await updateProgram(program, { name: 'Woodshop' }, actor);
        expect(result).toEqual({ ok: false, refusal: 'conflict', message: 'A program with this name already exists for that membership year.' });
    });
});

describe('updateProgram audit', () => {
    it('reads the "before" copy on the transaction client and audits it there', async () => {
        await updateProgram(program, { name: 'Woodshop' }, actor);
        expect(tx.program.findUnique).toHaveBeenCalledWith({ where: { id: program.id } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'EDIT', tableName: 'Program', affectedEntityId: program.id,
                oldData: rowAtWrite,
                newData: expect.objectContaining({ name: 'Woodshop' }),
            }),
        });
    });

    it('locks the program before a new leader\'s household, as enrollment does', async () => {
        const { lockLiveHouseholdsOf } = jest.requireMock('@/lib/household/archiveGuard');
        await updateProgram(program, { leadMentorId: 9 }, actor);
        expect(lockLiveHouseholdsOf).toHaveBeenCalledWith(tx, [9]);
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(lockLiveHouseholdsOf.mock.invocationCallOrder[0]);
    });
});

describe('updateProgram post-commit checks', () => {
    // The caller's copy is stale: a concurrent edit already set the ages.
    const lockedRow = { ...program, minAge: 10 };

    it('passes the locked row to the announce check as "before"', async () => {
        tx.program.findUnique.mockResolvedValueOnce(lockedRow);
        const { maybeAnnounceOnOpen } = jest.requireMock('@/lib/programAnnounce');
        await updateProgram(program, { name: 'Woodshop' }, actor);
        expect(maybeAnnounceOnOpen).toHaveBeenCalledWith(expect.objectContaining({ before: lockedRow }));
    });

    it('measures the age refit against the locked row', async () => {
        tx.program.findUnique.mockResolvedValueOnce(lockedRow);
        const prisma = jest.requireMock('@/lib/prisma').default;
        prisma.programParticipant.findMany.mockResolvedValueOnce([
            { status: 'ACTIVE', person: { name: 'Kid', dateOfBirth: new Date('2020-01-01'), isDeclaredAdult: false } },
        ]);
        const { emailBoardMembers } = jest.requireMock('@/lib/emailRecipients');
        await updateProgram(program, { minAge: 10 }, actor);
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });
});
