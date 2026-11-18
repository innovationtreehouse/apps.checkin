/**
 * @jest-environment node
 */
import { computeRecipientSnapshot, outreachAudienceWhere } from '@/lib/outreach/recipients';

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
const IN_WINDOW = new Date(Date.UTC(2026, 6, 15)); // live year 2026, the email is about 2026
const BEFORE_WINDOW = new Date(Date.UTC(2026, 9, 1)); // live year 2026, the email is about 2027
const skipNoted = (year: number) => ({ OR: [{ notRenewingYear: null }, { notRenewingYear: { not: year } }] });
const json = (v: unknown) => JSON.stringify(v);
const renewedFor = (year: number) => json({ appliesToYear: year }).slice(1, -1);

beforeEach(() => {
    jest.clearAllMocks();
    prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
});

describe('outreachAudienceWhere', () => {
    it.each(['opening', 'reminder'] as const)('the %s goes only to a lead of a live ACTIVE household', (type) => {
        const where = json(outreachAudienceWhere(type, BOUNDARY, IN_WINDOW));
        expect(where).toContain('"isHouseholdLead":true');
        expect(where).toContain('"archivedAt":null');
        expect(where).toContain('"status":"ACTIVE"');
    });

    it.each(['opening', 'reminder'] as const)('the %s skips a note for the year it is about, inside the window', (type) => {
        expect(json(outreachAudienceWhere(type, BOUNDARY, IN_WINDOW))).toContain(json(skipNoted(2026)).slice(1, -1));
    });

    it.each(['opening', 'reminder'] as const)('the %s sent before the window skips a note for the next year, not the live one', (type) => {
        const where = json(outreachAudienceWhere(type, BOUNDARY, BEFORE_WINDOW));
        expect(where).toContain(json(skipNoted(2027)).slice(1, -1));
        expect(where).not.toContain(json(skipNoted(2026)).slice(1, -1));
    });

    it('the reminder skips a household renewed for the year it is about', () => {
        expect(json(outreachAudienceWhere('reminder', BOUNDARY, IN_WINDOW))).toContain(renewedFor(2026));
        expect(json(outreachAudienceWhere('reminder', BOUNDARY, BEFORE_WINDOW))).toContain(renewedFor(2027));
    });

    it('the opening does not look at renewals', () => {
        expect(json(outreachAudienceWhere('opening', BOUNDARY, IN_WINDOW))).not.toContain('appliesToYear');
    });

    it('skips no note with no membership year set', () => {
        const where = outreachAudienceWhere('opening', null, IN_WINDOW);
        expect(where).toMatchObject({ household: { orgMembership: { status: 'ACTIVE' } } });
        expect(json(where)).not.toContain('notRenewingYear');
    });
});

describe('computeRecipientSnapshot', () => {
    it('lists the audience for the configured boundary', async () => {
        await computeRecipientSnapshot('reminder', BEFORE_WINDOW);
        const where = prisma.person.findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({ ...outreachAudienceWhere('reminder', BOUNDARY, BEFORE_WINDOW), email: { not: null } });
    });
});
