/**
 * @jest-environment node
 */
import { POST } from '../route';
import { getServerSession } from 'next-auth/next';
import prisma from '@/lib/prisma';
import { createClaimantProduct, createShopifySingleVariantProgram } from '@/lib/shopify/products';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

let txOpen = false;
const tx = {
    program: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        program: { updateMany: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
        boardSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (fn: (t: unknown) => unknown) => {
            txOpen = true;
            try { return await fn(tx); } finally { txOpen = false; }
        }),
    },
}));
jest.mock('@/lib/shopify/products', () => ({
    ...jest.requireActual('@/lib/shopify/products'),
    createShopifySingleVariantProgram: jest.fn(),
    createClaimantProduct: jest.fn(),
}));
jest.mock('@/lib/shopify/stock', () => ({
    ...jest.requireActual('@/lib/shopify/stock'),
    setProgramInventory: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/logger', () => ({ logBackendError: jest.fn() }));

const db = prisma as unknown as {
    program: { updateMany: jest.Mock; findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
};
const program = {
    id: 5, name: 'Robotics', maxParticipants: null,
    orgMemberPriceCents: 5000, nonOrgMemberPriceCents: 7500,
    shopifyProductId: null, shopifyVariantId: null, claimantShopifyVariantId: null,
};
const post = () => POST(
    new Request('http://localhost/api/programs/5/sync-shopify', { method: 'POST' }) as unknown as import('next/server').NextRequest,
    { params: Promise.resolve({ id: '5' }) } as unknown as never,
);

describe('POST /api/programs/[id]/sync-shopify claim', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 7, isBoardMember: true } });
        db.program.updateMany.mockResolvedValue({ count: 1 });
        db.program.findUniqueOrThrow.mockResolvedValue(program);
        tx.program.updateMany.mockResolvedValue({ count: 1 });
        tx.program.findUniqueOrThrow.mockResolvedValue({ ...program, shopifyVariantId: 'v1' });
        (createShopifySingleVariantProgram as jest.Mock).mockImplementation(async () => {
            expect(txOpen).toBe(false);
            return { shopifyProductId: 'p1', shopifyVariantId: 'v1' };
        });
        (createClaimantProduct as jest.Mock).mockImplementation(async () => {
            expect(txOpen).toBe(false);
            return { claimantShopifyProductId: 'cp1', claimantShopifyVariantId: 'cv1' };
        });
    });

    it('calls Shopify with no transaction open, under stable handles, then records under its token', async () => {
        expect((await post()).status).toBe(200);
        expect(createShopifySingleVariantProgram).toHaveBeenCalledWith('Robotics', 7500, null, 'checkin-program-5-robotics', true);
        expect(createClaimantProduct).toHaveBeenCalledWith('Robotics', 7500, 'checkin-program-5-robotics-reserved-seat');

        const claim = db.program.updateMany.mock.calls[0][0];
        const token = claim.data.shopifySyncToken;
        expect(token).toEqual(expect.any(String));
        expect(claim.where.OR).toEqual([
            { shopifySyncStartedAt: null },
            { shopifySyncStartedAt: { lt: expect.any(Date) } },
        ]);
        expect(Date.now() - claim.where.OR[1].shopifySyncStartedAt.lt.getTime()).toBeGreaterThanOrEqual(10 * 60_000);
        expect(tx.program.updateMany).toHaveBeenCalledWith({
            where: { id: 5, shopifySyncToken: token },
            data: expect.objectContaining({ shopifyVariantId: 'v1', claimantShopifyVariantId: 'cv1', shopifySyncStartedAt: null, shopifySyncToken: null }),
        });
    });

    it('refuses (409) while a fresh claim is held, calling nothing', async () => {
        db.program.updateMany.mockResolvedValueOnce({ count: 0 });
        db.program.findUnique.mockResolvedValue({ id: 5 });
        expect((await post()).status).toBe(409);
        expect(createShopifySingleVariantProgram).not.toHaveBeenCalled();
    });

    it('creates the public item as a draft while the store is closed to program seats', async () => {
        (prisma as unknown as { boardSettings: { findUnique: jest.Mock } }).boardSettings.findUnique.mockResolvedValueOnce({ programStoreClosedAt: new Date() });
        expect((await post()).status).toBe(200);
        expect(createShopifySingleVariantProgram).toHaveBeenCalledWith('Robotics', 7500, null, 'checkin-program-5-robotics', false);
    });

    it.each([
        ['an ended sale', { saleEndedAt: new Date('2026-01-01'), startAt: new Date('2099-01-01'), offSaleAt: null }],
        ['an ended program', { phase: 'FINISHED' }],
    ])('creates the public item hidden, marked hidden, with no stock pushed, for %s', async (_label, row) => {
        const capped = { ...program, ...row, maxParticipants: 10 };
        db.program.findUniqueOrThrow.mockResolvedValue(capped);
        tx.program.findUniqueOrThrow.mockResolvedValue({ ...capped, shopifyVariantId: 'v1' });
        expect((await post()).status).toBe(200);
        expect(createShopifySingleVariantProgram).toHaveBeenCalledWith('Robotics', 7500, 10, 'checkin-program-5-robotics', false);
        expect(tx.program.updateMany.mock.calls[0][0].data).toMatchObject({ productHiddenAt: expect.any(Date) });
        expect(jest.requireMock('@/lib/shopify/stock').setProgramInventory).not.toHaveBeenCalled();
    });

    it('lists the public item and sets its stock for a sale still running', async () => {
        const capped = { ...program, maxParticipants: 10, phase: 'UPCOMING', startAt: new Date('2099-01-01'), offSaleAt: null, saleEndedAt: null };
        db.program.findUniqueOrThrow.mockResolvedValue(capped);
        tx.program.findUniqueOrThrow.mockResolvedValue({ ...capped, shopifyVariantId: 'v1' });
        expect((await post()).status).toBe(200);
        expect(createShopifySingleVariantProgram).toHaveBeenCalledWith('Robotics', 7500, 10, 'checkin-program-5-robotics', true);
        expect(tx.program.updateMany.mock.calls[0][0].data).not.toHaveProperty('productHiddenAt');
        expect(jest.requireMock('@/lib/shopify/stock').setProgramInventory).toHaveBeenCalled();
    });

    it('is a 409 that records nothing when its claim was taken over mid-run', async () => {
        tx.program.updateMany.mockResolvedValueOnce({ count: 0 });
        expect((await post()).status).toBe(409);
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('releases its claim when recording fails', async () => {
        db.$transaction.mockRejectedValueOnce(new Error('timeout'));
        expect((await post()).status).toBe(500);
        const release = db.program.updateMany.mock.calls.at(-1)[0];
        expect(release.where).toEqual({ id: 5, shopifySyncToken: db.program.updateMany.mock.calls[0][0].data.shopifySyncToken });
        expect(release.data).toEqual({ shopifySyncStartedAt: null, shopifySyncToken: null });
    });
});
