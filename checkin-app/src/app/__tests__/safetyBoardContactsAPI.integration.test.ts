/**
 * @jest-environment node
 */
/**
 * Guard for GET /api/safety/board-contacts.
 *
 * Pins the field set leaving the emergency board contact sheet. Two distinct
 * properties, and they pull in opposite directions:
 *
 *  - Keyholders DO receive email + phone. That is the registry's
 *    'keyholders:pii' grant — deliberate and owner-confirmed, because a
 *    keyholder on shift needs to reach a board member and this is the sheet
 *    they reach for.
 *  - `dateOfBirth` and `googleId` must NEVER ship, for ANY caller, sysadmin
 *    and board included. Enforced twice: the route's tight Prisma `select`
 *    (defense in depth) AND the outbound stripper. Widening the `select`
 *    makes these assertions fail, which is the point.
 */
import { GET } from '@/app/api/safety/board-contacts/route';
import prisma from '@/lib/prisma';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const TAG = 'safety-board-contacts-test';

function req() {
    return new Request('http://localhost/api/safety/board-contacts') as unknown as import('next/server').NextRequest;
}

describe('GET /api/safety/board-contacts', () => {
    let boardId: number;
    let keyholderId: number;
    const householdIds: number[] = [];

    beforeAll(async () => {
        // A board member WITH non-null pii, so "must not leak dob/googleId" is a
        // meaningful assertion (an all-null fixture would pass vacuously).
        const board = await prisma.person.create({
            data: {
                name: `Board ${TAG}`,
                email: `board-${TAG}@example.com`,
                phone: '555-0001',
                dateOfBirth: new Date('1980-01-01'),
                googleId: `google-${TAG}`,
                isBoardMember: true,
                household: { create: { name: "Test HH" } },
            },
        });
        boardId = board.id;
        householdIds.push(board.householdId);

        const isKeyholder = await prisma.person.create({
            data: {
                name: `Keyholder ${TAG}`,
                email: `isKeyholder-${TAG}@example.com`,
                isKeyholder: true,
                household: { create: { name: "Test HH" } },
            },
        });
        keyholderId = isKeyholder.id;
        householdIds.push(isKeyholder.householdId);
    });

    beforeEach(() => jest.clearAllMocks());

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { id: { in: [boardId, keyholderId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('a board member gets rows that never contain dob or googleId', async () => {
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await GET(req());
        expect(res.status).toBe(200);
        const { members } = await res.json();

        expect(Array.isArray(members)).toBe(true);
        const seeded = members.find((r: { id: number }) => r.id === boardId);
        expect(seeded).toBeDefined();
        // Board legitimately sees contact fields...
        expect(seeded.email).toBe(`board-${TAG}@example.com`);
        expect(seeded.phone).toBe('555-0001');
        // ...but dob/googleId must never ship, for any row.
        for (const row of members) {
            expect(row).not.toHaveProperty('dateOfBirth');
            expect(row).not.toHaveProperty('googleId');
        }
    });

    it('a isKeyholder gets email and phone — the owner-confirmed emergency-contact grant', async () => {
        mockSession.mockResolvedValue({ user: { id: keyholderId, isKeyholder: true } });

        const res = await GET(req());
        expect(res.status).toBe(200);
        const { members } = await res.json();

        const seeded = members.find((r: { id: number }) => r.id === boardId);
        expect(seeded).toBeDefined();
        // Public fields survive.
        expect(seeded.name).toBe(`Board ${TAG}`);
        // Contact pii reaches keyholders BY DESIGN: the registry's
        // 'keyholders:pii' grant on this route. A keyholder on shift must be
        // able to phone a board member. If this assertion ever flips to
        // not.toHaveProperty, the emergency sheet has silently gone blank.
        expect(seeded.email).toBe(`board-${TAG}@example.com`);
        expect(seeded.phone).toBe('555-0001');
        // dob/googleId stay out for keyholders too.
        for (const row of members) {
            expect(row).not.toHaveProperty('dateOfBirth');
            expect(row).not.toHaveProperty('googleId');
        }
    });
});
