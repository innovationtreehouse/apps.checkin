/**
 * @jest-environment node
 *
 * updateProgram's day boundaries — the leader's end-date gate and the Board's
 * re-open guard — use the day in the org's configured zone.
 */
import type { Program } from '@/generated/prisma/client';
import { updateProgram } from '@/lib/programs/update';
import { orgToday } from '@/lib/appSettings';
import { calendarDayIn } from '@/lib/time';

jest.mock('@/lib/appSettings', () => ({ orgToday: jest.fn() }));
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
jest.mock('@/lib/programAnnounce', () => ({ maybeAnnounceOnOpen: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/shopify/stock', () => ({ STOCK_BOOKKEEPING_RESET: {} }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn() }));
jest.mock('@/lib/conflictOfInterest', () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/household/archiveGuard', () => ({ lockLiveHouseholdsOf: jest.fn().mockResolvedValue(undefined) }));

const program = {
    id: 5, name: 'Robotics', leadMentorId: 7, phase: 'RUNNING', enrollmentStatus: 'CLOSED',
    startAt: new Date('2026-09-01'), endAt: new Date('2026-10-12'), appliesToYear: 2026,
    offSaleAt: new Date('2026-09-01'), saleEndedAt: new Date('2026-09-01'), productHiddenAt: null,
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

const board = { id: 1, isSysadmin: false, isBoardMember: true };
const lead = { id: 7, isSysadmin: false, isBoardMember: false };

// 11:30 PM on the 11th in Chicago, 12:30 AM on the 12th in New York.
const NOW = new Date('2026-10-12T04:30:00Z');
const inZone = (zone: string) =>
    jest.mocked(orgToday).mockImplementation(async (now = new Date()) => calendarDayIn(now, zone));

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe("a leader ends a program on its end date in the org's zone", () => {
    it('allows it once the end date has arrived in New York', async () => {
        inZone('America/New_York');
        expect((await updateProgram(program, { phase: 'FINISHED' }, lead)).ok).toBe(true);
    });

    it('refuses it while the end date is still tomorrow in Chicago', async () => {
        inZone('America/Chicago');
        const result = await updateProgram(program, { phase: 'FINISHED' }, lead);
        expect(result).toMatchObject({ ok: false, refusal: 'forbidden' });
    });
});

describe("the Board re-opens an ended sale only to a date after today in the org's zone", () => {
    const reopen = { offSaleAt: '2026-10-12', enrollmentStatus: 'OPEN' as const };

    it('refuses a date that is today in New York', async () => {
        inZone('America/New_York');
        const result = await updateProgram(program, reopen, board);
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(tx.program.update).not.toHaveBeenCalled();
    });

    it('re-arms the sale when that date is still tomorrow in Chicago', async () => {
        inZone('America/Chicago');
        const result = await updateProgram(program, reopen, board);
        expect(result.ok).toBe(true);
        expect(tx.program.update.mock.calls[0][0].data).toMatchObject({ saleEndedAt: null });
    });
});
