/**
 * @jest-environment node
 */
/**
 * PUT /api/settings/membership — devSigningTarget (the dev-only signing radio).
 * Off-dev the API IGNORES the field (the whole form still POSTs it) instead of
 * 400'ing the batch, so prod's BoardSettings row can never hold a target while the
 * rest of the update still saves. On dev the field validates and persists.
 */
import { PUT } from '@/app/api/settings/membership/route';
import prisma from '@/lib/prisma';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const TAG = 'signing-target-test';
const ORIGINAL_CHECKIN_ENV = process.env.CHECKIN_ENV;

describe('PUT /api/settings/membership — devSigningTarget', () => {
    let boardId: number;
    let householdId: number;
    let prev: { devSigningTarget: string | null; bgRecheckMonths: number; standardMembershipFeeCents: number } | null = null;

    beforeAll(async () => {
        const board = await prisma.person.create({
            data: { name: 'Signing Board', email: `board-${TAG}@example.com`, household: { create: { name: 'Test HH' } } },
        });
        boardId = board.id;
        householdId = board.householdId;
        const existing = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        prev = existing
            ? { devSigningTarget: existing.devSigningTarget, bgRecheckMonths: existing.bgRecheckMonths, standardMembershipFeeCents: existing.standardMembershipFeeCents }
            : null;
    });

    afterAll(async () => {
        // Restore prior settings, or null the field these tests set when no row existed
        // yet: signingMockActive() reads devSigningTarget, so a leaked 'debug' forces the
        // signing mock provider on every later integration suite sharing this DB.
        await prisma.boardSettings.updateMany({ where: { id: 1 }, data: prev ?? { devSigningTarget: null } });
        await prisma.person.deleteMany({ where: { id: boardId } });
        await prisma.household.deleteMany({ where: { id: householdId } });
        process.env.CHECKIN_ENV = ORIGINAL_CHECKIN_ENV;
    });

    // CHECKIN_ENV=local arms the keyless-kiosk fallback in authenticateRequest,
    // which hijacks any cookie-less request as `kiosk` → 403 before the role
    // gate — send a cookie so the mocked session is used.
    const put = (body: unknown) =>
        PUT(new Request('http://localhost/api/settings/membership', {
            method: 'PUT',
            headers: { cookie: 'session=test' },
            body: JSON.stringify(body),
        }) as unknown as import('next/server').NextRequest);

    it('accepts and persists the target on a dev instance', async () => {
        process.env.CHECKIN_ENV = 'dev';
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await put({ devSigningTarget: 'debug' });
        expect(res.status).toBe(200);
        const row = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        expect(row?.devSigningTarget).toBe('debug');
    });

    it('off-dev, ignores devSigningTarget but persists the rest of the update', async () => {
        process.env.CHECKIN_ENV = 'local';
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const before = (await prisma.boardSettings.findUnique({ where: { id: 1 } }))?.devSigningTarget ?? null;
        const res = await put({ devSigningTarget: 'zoho', bgRecheckMonths: 18, standardMembershipFeeCents: 9900 });
        expect(res.status).toBe(200);

        const row = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        // The env-inapplicable field is dropped, not written...
        expect(row?.devSigningTarget ?? null).toBe(before);
        // ...while the applicable fields in the same PUT persist.
        expect(row?.bgRecheckMonths).toBe(18);
        expect(row?.standardMembershipFeeCents).toBe(9900);
    });

    it('off-dev, a genuinely invalid fee still 400s the whole update (all-or-nothing preserved)', async () => {
        process.env.CHECKIN_ENV = 'local';
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await put({ devSigningTarget: 'zoho', standardMembershipFeeCents: -1 });
        expect(res.status).toBe(400);
    });

    it('rejects values outside zoho/debug/null on dev', async () => {
        process.env.CHECKIN_ENV = 'dev';
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await put({ devSigningTarget: 'production-zoho' });
        expect(res.status).toBe(400);
    });
});
