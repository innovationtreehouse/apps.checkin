/**
 * @jest-environment node
 */
/**
 * A board email change on PUT /api/membership-ops/participants/[id] ends every
 * Google link the person had, so only the new address can sign in as them.
 * Drives the real NextAuth adapter lookups against real Postgres.
 */
import { PUT } from '@/app/api/membership-ops/participants/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { expectAuditRow, auditJson } from '@/test-helpers/expectAuditRow';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// The adapter module reads the Google/NextAuth secrets at construction; CI sets none.
jest.mock('@/lib/config', () => {
    const actual = jest.requireActual('@/lib/config');
    return {
        __esModule: true,
        ...actual,
        config: {
            ...actual.config,
            nextAuthSecret: jest.fn(() => 'test-secret'),
            googleClientId: jest.fn(() => 'gid'),
            googleClientSecret: jest.fn(() => 'gsecret'),
        },
    };
});
jest.unmock('@/lib/auth-options');

import { authOptions } from '@/lib/auth-options';

const adapter = authOptions.adapter as unknown as {
    getUserByEmail: (email: string) => Promise<{ id: string } | null>;
    getUserByAccount: (key: { provider: string; providerAccountId: string }) => Promise<{ id: string } | null>;
    linkAccount: (account: Record<string, unknown>) => Promise<unknown>;
};

const TAG = 'email-unlink-test';
const OLD_EMAIL = `old-${TAG}@example.com`;
const NEW_EMAIL = `new-${TAG}@example.com`;
const OLD_SUB = `${TAG}-old-sub`;
const NEW_SUB = `${TAG}-new-sub`;

async function wipe() {
    const rows = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { householdId: true } });
    const householdIds = [...new Set(rows.map((r) => r.householdId).filter((id): id is number => id != null))];
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    if (householdIds.length) {
        await prisma.household.deleteMany({ where: { id: { in: householdIds }, householdMembers: { none: {} } } });
    }
}

function put(id: number, body: unknown) {
    const req = new Request(`http://localhost:4000/api/membership-ops/participants/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    return PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: String(id) }) });
}

describe('board email change unlinks Google sign-ins', () => {
    let boardId: number;
    let personId: number;

    beforeAll(async () => {
        await wipe();
        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: 'Board HH' } } },
        });
        boardId = board.id;
    });

    beforeEach(async () => {
        const person = await prisma.person.create({
            data: {
                email: OLD_EMAIL, name: 'Linked Person', googleId: OLD_SUB, emailVerified: new Date(),
                household: { create: { name: 'Linked HH' } },
                accounts: { create: { type: 'oauth', provider: 'google', providerAccountId: OLD_SUB } },
            },
        });
        personId = person.id;
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isSysadmin: false, isBoardMember: true } });
    });

    afterEach(async () => {
        await prisma.person.deleteMany({ where: { id: personId } });
        await prisma.household.deleteMany({ where: { name: 'Linked HH', householdMembers: { none: {} } } });
    });

    afterAll(wipe);

    // Board ruling B1/B2, 2026-10-27; trusted list per owner decision 2026-10-27.
    describe('on a trusted person', () => {
        beforeEach(async () => {
            await prisma.personRole.create({ data: { personId, role: 'FINANCE' } });
        });

        it('refuses a sysadmin who is not on the board', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isSysadmin: true, isBoardMember: false } });
            expect((await put(personId, { email: NEW_EMAIL, emailChangeReason: 'New address' })).status).toBe(403);
            expect((await prisma.person.findUnique({ where: { id: personId } }))?.email).toBe(OLD_EMAIL);
        });

        it('refuses a board member with no reason', async () => {
            expect((await put(personId, { email: NEW_EMAIL })).status).toBe(400);
            expect((await prisma.person.findUnique({ where: { id: personId } }))?.email).toBe(OLD_EMAIL);
        });

        it('lets a board member change it with a reason, audited', async () => {
            expect((await put(personId, { email: NEW_EMAIL, emailChangeReason: 'New address' })).status).toBe(200);
            expect((await prisma.person.findUnique({ where: { id: personId } }))?.email).toBe(NEW_EMAIL);
            const audit = await expectAuditRow(prisma, { action: 'EDIT', tableName: 'Person', affectedEntityId: personId });
            expect(audit.actorId).toBe(boardId);
            expect(auditJson(audit.newData).emailChangeReason).toBe('New address');
        });
    });

    it('the old Google account no longer resolves, and the new address links', async () => {
        expect((await adapter.getUserByAccount({ provider: 'google', providerAccountId: OLD_SUB }))?.id).toBe(String(personId));

        const res = await put(personId, { email: NEW_EMAIL, emailChangeReason: 'New address' });
        expect(res.status).toBe(200);

        expect(await adapter.getUserByAccount({ provider: 'google', providerAccountId: OLD_SUB })).toBeNull();
        expect(await adapter.getUserByEmail(OLD_EMAIL)).toBeNull();
        const stored = await prisma.person.findUnique({ where: { id: personId } });
        expect(stored?.emailVerified).toBeNull();
        expect(stored?.googleId).toBeNull();

        const audit = await expectAuditRow(prisma, { action: 'DELETE', tableName: 'Account', affectedEntityId: personId });
        expect(audit.actorId).toBe(boardId);
        expect(auditJson(audit.oldData).linkedAccounts).toBe(1);

        // NextAuth's first sign-in from the new address: email lookup, then link.
        const byNewEmail = await adapter.getUserByEmail(NEW_EMAIL);
        expect(byNewEmail?.id).toBe(String(personId));
        await adapter.linkAccount({ userId: byNewEmail!.id, type: 'oauth', provider: 'google', providerAccountId: NEW_SUB });
        expect((await adapter.getUserByAccount({ provider: 'google', providerAccountId: NEW_SUB }))?.id).toBe(String(personId));
    });

    it('resending the same address in another case keeps the link', async () => {
        const res = await put(personId, { email: OLD_EMAIL.toUpperCase(), name: 'Renamed' });
        expect(res.status).toBe(200);

        expect((await adapter.getUserByAccount({ provider: 'google', providerAccountId: OLD_SUB }))?.id).toBe(String(personId));
        const stored = await prisma.person.findUnique({ where: { id: personId } });
        expect(stored?.emailVerified).not.toBeNull();
        expect(await prisma.auditLog.count({ where: { tableName: 'Account', affectedEntityId: personId } })).toBe(0);
    });
});
