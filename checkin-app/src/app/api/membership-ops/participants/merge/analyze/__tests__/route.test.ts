/**
 * @jest-environment node
 */
/**
 * Unit tests for the `bgNotice` field of the merge analysis (which date the survivor
 * would adopt in each direction) and the attestation ids on background-check collisions.
 * Other collisions and blocks are in ../../__tests__/route.integration.test.ts.
 */
import type { NextRequest } from 'next/server';
import { GET } from '../route';
import prisma from '@/lib/prisma';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), findFirst: jest.fn() },
        program: { findMany: jest.fn().mockResolvedValue([]) },
        tool: { findMany: jest.fn().mockResolvedValue([]) },
        event: { findMany: jest.fn().mockResolvedValue([]) },
        backgroundCheckAttestation: { findMany: jest.fn().mockResolvedValue([]) },
        visit: { findFirst: jest.fn().mockResolvedValue(null) },
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;
const db = prisma as unknown as {
    person: { findUnique: jest.Mock; findFirst: jest.Mock };
    backgroundCheckAttestation: { findMany: jest.Mock };
};

const RECENT = new Date(Date.now() - 86_400_000);
const LONG_AGO = new Date('2000-01-01T00:00:00.000Z');

type Subject = { lastBackgroundCheck: Date | null };

/** Person 1 and person 2, with their date fields served only to the background-check read. */
function mockPeople(subjects: Record<number, Subject>) {
    db.person.findUnique.mockImplementation(async ({ where, select }: { where: { id: number }; select: Record<string, unknown> }) => {
        if ('lastBackgroundCheck' in select) {
            return subjects[where.id];
        }
        return { id: where.id, name: `Person ${where.id}`, household: null, _count: {} };
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
});

describe('GET merge/analyze bgNotice', () => {
    it('reports the newer date only in the direction that keeps the older record', async () => {
        mockPeople({ 1: { lastBackgroundCheck: null }, 2: { lastBackgroundCheck: RECENT } });
        const { bgNotice } = await analyze();
        expect(bgNotice.aAsKeeper).toEqual({ date: RECENT.toISOString() });
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
});

describe('GET merge/analyze background-check collisions', () => {
    type Row = { id: number; processId: number; reviewerId: number; subjectPersonId: number | null };

    async function collisionsFor(rows: Row[]) {
        mockPeople({ 1: { lastBackgroundCheck: null }, 2: { lastBackgroundCheck: null } });
        db.backgroundCheckAttestation.findMany.mockResolvedValueOnce(rows);
        const { collisions } = await analyze();
        return collisions as Array<{ type: string; attestationIds?: number[] }>;
    }

    it("names both reviewers' attestations on a shared review", async () => {
        const collisions = await collisionsFor([
            { id: 11, processId: 7, reviewerId: 1, subjectPersonId: 50 },
            { id: 12, processId: 7, reviewerId: 2, subjectPersonId: 51 },
            { id: 13, processId: 8, reviewerId: 1, subjectPersonId: 50 },
        ]);
        expect(collisions).toEqual([expect.objectContaining({ type: 'bgAttestation', attestationIds: [11, 12] })]);
    });

    it('names the attestation one record reviewed about the other', async () => {
        const collisions = await collisionsFor([
            { id: 21, processId: 7, reviewerId: 1, subjectPersonId: 2 },
        ]);
        expect(collisions).toEqual([expect.objectContaining({ type: 'bgAttestationCrossRole', attestationIds: [21] })]);
    });

    it('names both subject attestations one reviewer made under the same process', async () => {
        const collisions = await collisionsFor([
            { id: 31, processId: 7, reviewerId: 9, subjectPersonId: 1 },
            { id: 32, processId: 7, reviewerId: 9, subjectPersonId: 2 },
            { id: 33, processId: 8, reviewerId: 9, subjectPersonId: 2 },
        ]);
        expect(collisions).toEqual([expect.objectContaining({ type: 'bgAttestationSubject', attestationIds: [31, 32] })]);
    });

    it('reports no collision for unrelated attestations', async () => {
        const collisions = await collisionsFor([
            { id: 41, processId: 7, reviewerId: 1, subjectPersonId: 50 },
            { id: 42, processId: 8, reviewerId: 2, subjectPersonId: 51 },
        ]);
        expect(collisions).toEqual([]);
    });
});
