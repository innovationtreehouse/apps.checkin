/**
 * @jest-environment node
 */
import { computeRecipientSnapshot } from '@/lib/outreach/recipients';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        boardSettings: { findUnique: jest.fn() },
        person: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prisma = require('@/lib/prisma').default;

const BOUNDARY = new Date(Date.UTC(2020, 8, 1)); // Sep 1; the renewal window opens Jul 1
const IN_WINDOW = new Date(Date.UTC(2026, 6, 15));
const skipNoted = (year: number) => ({ OR: [{ notRenewingYear: null }, { notRenewingYear: { not: year } }] });

function where(): unknown {
    return prisma.person.findMany.mock.calls[0][0].where;
}

beforeEach(() => {
    jest.clearAllMocks();
    prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
});

describe('renewal outreach audience', () => {
    it.each(['opening', 'reminder'] as const)('the %s skips a household that said it won\'t renew into the noted year', async (type) => {
        await computeRecipientSnapshot(type, IN_WINDOW);
        expect(JSON.stringify(where())).toContain(JSON.stringify(skipNoted(2026)).slice(1, -1));
    });

    it('skips only the noted year: off season the note is for the year after the live one', async () => {
        await computeRecipientSnapshot('opening', new Date(Date.UTC(2026, 9, 1)));
        expect(where()).toMatchObject({ household: { orgMembership: skipNoted(2027) } });
    });

    it('skips nothing with no membership year set', async () => {
        prisma.boardSettings.findUnique.mockResolvedValue(null);
        await computeRecipientSnapshot('opening', IN_WINDOW);
        expect(where()).toMatchObject({ household: { orgMembership: { status: 'ACTIVE' } } });
        expect(JSON.stringify(where())).not.toContain('notRenewingYear');
    });
});
