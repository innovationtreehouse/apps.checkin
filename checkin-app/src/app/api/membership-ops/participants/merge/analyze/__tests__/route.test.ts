/**
 * @jest-environment node
 */
/**
 * Unit tests for the `bgNotice` field of the merge analysis: which date the survivor
 * would adopt in each direction, and when that date would make the household valid.
 * Collisions and blocks are in ../../__tests__/route.integration.test.ts.
 */
import type { NextRequest } from 'next/server';
import { GET } from '../route';
import prisma from '@/lib/prisma';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), findFirst: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        program: { findMany: jest.fn().mockResolvedValue([]) },
        tool: { findMany: jest.fn().mockResolvedValue([]) },
        event: { findMany: jest.fn().mockResolvedValue([]) },
        orgMembershipProcess: { count: jest.fn().mockResolvedValue(0) },
        backgroundCheckAttestation: { findMany: jest.fn().mockResolvedValue([]) },
        visit: { findFirst: jest.fn().mockResolvedValue(null) },
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;
const db = prisma as unknown as {
    person: { findUnique: jest.Mock; findFirst: jest.Mock };
    boardSettings: { findUnique: jest.Mock };
};

const RECENT = new Date(Date.now() - 86_400_000);
const LONG_AGO = new Date('2000-01-01T00:00:00.000Z');

type Subject = { lastBackgroundCheck: Date | null; isHouseholdLead?: boolean; householdId?: number | null };

/** Person 1 and person 2, with their date fields served only to the background-check read. */
function mockPeople(subjects: Record<number, Subject>) {
    db.person.findUnique.mockImplementation(async ({ where, select }: { where: { id: number }; select: Record<string, unknown> }) => {
        if ('lastBackgroundCheck' in select) {
            return { isHouseholdLead: true, householdId: where.id * 10, ...subjects[where.id] };
        }
        return { id: where.id, name: `Person ${where.id}`, mergedIntoId: null, household: null, _count: {} };
    });
}

async function analyze() {
    const res = await GET(new Request('http://localhost/api/membership-ops/participants/merge/analyze?a=1&b=2') as unknown as NextRequest);
    expect(res.status).toBe(200);
    return res.json();
}

beforeEach(() => {
    mockSession.mockResolvedValue({ user: { id: 9, isSysadmin: true } });
    db.person.findFirst.mockResolvedValue(null);
    db.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: new Date('2026-08-01T00:00:00.000Z'), bgRecheckMonths: 36 });
});

describe('GET merge/analyze bgNotice', () => {
    it('reports the newer date only in the direction that keeps the older record', async () => {
        mockPeople({ 1: { lastBackgroundCheck: null }, 2: { lastBackgroundCheck: RECENT } });
        const { bgNotice } = await analyze();
        expect(bgNotice.aAsKeeper).toEqual({ date: RECENT.toISOString(), makesHouseholdValid: true });
        expect(bgNotice.bAsKeeper).toBeNull();
    });

    it('keeps the raw dates out of the participants payload', async () => {
        mockPeople({ 1: { lastBackgroundCheck: LONG_AGO }, 2: { lastBackgroundCheck: RECENT } });
        const { participants } = await analyze();
        for (const p of participants) expect(p).not.toHaveProperty('lastBackgroundCheck');
    });

    it('is null both ways when neither record has a date', async () => {
        mockPeople({ 1: { lastBackgroundCheck: null }, 2: { lastBackgroundCheck: null } });
        const { bgNotice } = await analyze();
        expect(bgNotice).toEqual({ aAsKeeper: null, bAsKeeper: null });
    });

    it.each<[string, Subject, Subject]>([
        ['the carried date is too old to count', { lastBackgroundCheck: null }, { lastBackgroundCheck: LONG_AGO }],
        ['the keeper is not a household lead', { lastBackgroundCheck: null, isHouseholdLead: false }, { lastBackgroundCheck: RECENT }],
        ['the keeper has no household', { lastBackgroundCheck: null, householdId: null }, { lastBackgroundCheck: RECENT }],
    ])('names the date but not validity when %s', async (_why, keeper, merged) => {
        mockPeople({ 1: keeper, 2: merged });
        const { bgNotice } = await analyze();
        expect(bgNotice.aAsKeeper.makesHouseholdValid).toBe(false);
    });

    it('does not claim validity when the household is already covered', async () => {
        db.person.findFirst.mockResolvedValue({ id: 3 });
        mockPeople({ 1: { lastBackgroundCheck: null }, 2: { lastBackgroundCheck: RECENT } });
        const { bgNotice } = await analyze();
        expect(bgNotice.aAsKeeper.makesHouseholdValid).toBe(false);
    });

    it('does not claim validity when the recheck policy is unset', async () => {
        db.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: null, bgRecheckMonths: 0 });
        mockPeople({ 1: { lastBackgroundCheck: null }, 2: { lastBackgroundCheck: RECENT } });
        const { bgNotice } = await analyze();
        expect(bgNotice.aAsKeeper.makesHouseholdValid).toBe(false);
    });
});
