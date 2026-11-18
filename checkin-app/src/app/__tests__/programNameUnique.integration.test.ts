/**
 * @jest-environment node
 *
 * A program's name is unique within its membership year, compared trimmed and
 * case-insensitively, and a refused create makes no store product.
 */

import { POST } from '@/app/api/programs/route';
import { PATCH } from '@/app/api/programs/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';
import { setMembershipYearBoundary } from '@/test-helpers/boardSettings';
import { createClaimantProduct, createShopifySingleVariantProgram } from '@/lib/shopify/products';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn() }));
jest.mock('@/lib/shopify/products', () => ({
    programProductHandle: jest.requireActual('@/lib/shopify/products').programProductHandle,
    createShopifySingleVariantProgram: jest.fn(),
    createClaimantProduct: jest.fn(),
}));
jest.mock('@/lib/shopify/stock', () => ({
    ...jest.requireActual('@/lib/shopify/stock'),
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
}));

const TAG = 'program-name-unique-test';
const TAKEN = 'A program with this name already exists for that membership year.';

describe('program name is unique per membership year', () => {
    let restoreBoundary: () => Promise<void>;
    let boardId: number;
    let leadId: number;
    const householdIds: number[] = [];

    const create = (name: string, startAt = '2026-10-01', endAt = '2026-12-15') => POST(new Request('http://localhost/api/programs', {
        method: 'POST',
        headers: { cookie: 'session=test' },
        body: JSON.stringify({ name, leadMentorId: leadId, startAt, endAt, maxParticipants: 10, nonMemberPrice: '50' }),
    }) as unknown as NextRequest);

    const rename = (id: number, name: string) => PATCH(
        new Request(`http://localhost/api/programs/${id}`, { method: 'PATCH', headers: { cookie: 'session=test' }, body: JSON.stringify({ name }) }) as unknown as NextRequest,
        { params: Promise.resolve({ id: String(id) }) },
    );

    beforeAll(async () => {
        restoreBoundary = await setMembershipYearBoundary();
        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, isDeclaredAdult: true, household: { create: { name: TAG } } },
        });
        const lead = await prisma.person.create({
            data: { email: `lead-${TAG}@example.com`, name: 'Lead', isDeclaredAdult: true, household: { create: { name: TAG } } },
        });
        boardId = board.id;
        leadId = lead.id;
        householdIds.push(board.householdId, lead.householdId);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        (createShopifySingleVariantProgram as jest.Mock).mockResolvedValue({ shopifyProductId: `p-${TAG}`, shopifyVariantId: `v-${TAG}-${Date.now()}` });
        (createClaimantProduct as jest.Mock).mockResolvedValue(null);
    });

    afterAll(async () => {
        await prisma.program.deleteMany({ where: { nameKey: { startsWith: TAG.toLowerCase() } } });
        await prisma.auditLog.deleteMany({ where: { actorId: boardId } });
        await prisma.person.deleteMany({ where: { id: { in: [boardId, leadId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
        await restoreBoundary();
    });

    it('refuses a second create differing only by case and spaces, with no store call', async () => {
        const first = await create(`${TAG} Robotics`);
        expect(first.status).toBe(200);
        const { program } = await first.json();
        expect(await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).toMatchObject({ name: `${TAG} Robotics`, nameKey: `${TAG} robotics`, appliesToYear: 2026 });
        expect(createShopifySingleVariantProgram).toHaveBeenCalledTimes(1);
        const idsAudit = await prisma.auditLog.findFirst({ where: { tableName: 'Program', affectedEntityId: program.id, action: 'EDIT' } });
        expect(idsAudit?.newData).toMatchObject({ shopifyProductId: `p-${TAG}` });

        jest.clearAllMocks();
        const second = await create(`  ${TAG.toUpperCase()} ROBOTICS `);
        expect(second.status).toBe(409);
        expect((await second.json()).error).toBe(TAKEN);
        expect(createShopifySingleVariantProgram).not.toHaveBeenCalled();
        expect(createClaimantProduct).not.toHaveBeenCalled();
        expect(await prisma.program.count({ where: { nameKey: `${TAG} robotics` } })).toBe(1);
    });

    it('allows the same name in a different membership year', async () => {
        const res = await create(`${TAG} Robotics`, '2027-10-01', '2027-12-15');
        expect(res.status).toBe(200);
        expect(await prisma.program.count({ where: { nameKey: `${TAG} robotics` } })).toBe(2);
    });

    it('refuses a rename into a name its membership year already has', async () => {
        const res = await create(`${TAG} Woodshop`);
        expect(res.status).toBe(200);
        const { program } = await res.json();

        const renamed = await rename(program.id, `${TAG} robotics`);
        expect(renamed.status).toBe(409);
        expect((await renamed.json()).error).toBe(TAKEN);
        expect((await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).name).toBe(`${TAG} Woodshop`);
    });
});
