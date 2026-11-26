/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { config, DEV_MOCK_MEMBERSHIP_VARIANT_ID } from '@/lib/config';
import { ensurePaymentLink, membershipProductProblems, yearVariantId } from '@/lib/membership/payment';
import { variantSaleState } from '@/lib/shopify/products';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        membershipYearVariant: { findUnique: jest.fn() },
        orgMembershipProcess: { findUnique: jest.fn(), findMany: jest.fn() },
        orgMembership: { findUnique: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
    },
}));
jest.mock('@/lib/shopify/products', () => ({ variantSaleState: jest.fn() }));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() }, logBackendError: jest.fn() }));

const variant = prisma.membershipYearVariant.findUnique as jest.Mock;
const saleState = variantSaleState as jest.Mock;
const boundary = new Date('2000-09-01T00:00:00.000Z');
const at = (date: Date) => jest.useFakeTimers({ now: date, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout'] });

let mockActive: jest.SpyInstance;
let storeDomain: jest.SpyInstance;
beforeEach(() => {
    jest.clearAllMocks();
    mockActive = jest.spyOn(config, 'shopifyMockActive').mockReturnValue(false);
    storeDomain = jest.spyOn(config, 'shopifyStoreDomain').mockReturnValue('shop.example');
    jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: boundary, standardMembershipFeeCents: 5000 } as never);
    jest.mocked(prisma.orgMembership.findUnique).mockResolvedValue({ isVolunteerFamily: false } as never);
    saleState.mockResolvedValue('sellable');
});
afterEach(() => {
    mockActive.mockRestore();
    storeDomain.mockRestore();
    jest.useRealTimers();
});

describe('yearVariantId', () => {
    it("sells the given year's row", async () => {
        variant.mockResolvedValue({ shopifyVariantId: '111' });
        await expect(yearVariantId(2026)).resolves.toBe('111');
        expect(variant).toHaveBeenCalledWith(expect.objectContaining({ where: { membershipYear: 2026 } }));
    });

    it('sells nothing when the year has no row, or there is no year', async () => {
        variant.mockResolvedValue(null);
        await expect(yearVariantId(2026)).resolves.toBeNull();
        await expect(yearVariantId(null)).resolves.toBeNull();
    });

    it('sells the mock variant when the mock is active and the year has no row', async () => {
        mockActive.mockReturnValue(true);
        variant.mockResolvedValue(null);
        await expect(yearVariantId(2026)).resolves.toBe(DEV_MOCK_MEMBERSHIP_VARIANT_ID);
        await expect(yearVariantId(null)).resolves.toBe(DEV_MOCK_MEMBERSHIP_VARIANT_ID);
    });

    it("prefers the year's row over the mock variant", async () => {
        mockActive.mockReturnValue(true);
        variant.mockResolvedValue({ shopifyVariantId: '111' });
        await expect(yearVariantId(2026)).resolves.toBe('111');
    });
});

describe('ensurePaymentLink sells the application year', () => {
    const awaiting = { id: 9, status: 'PENDING_PAYMENT', orgMembershipId: 4, membershipYear: 2025, createdAt: new Date(Date.UTC(2026, 5, 20)) };
    beforeEach(() => jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue(awaiting as never));

    it("links the application's own year after the live year moves on", async () => {
        at(new Date(Date.UTC(2026, 6, 10, 12)));
        variant.mockResolvedValue({ shopifyVariantId: '2025v' });
        const link = await ensurePaymentLink(9);
        expect(variant).toHaveBeenCalledWith(expect.objectContaining({ where: { membershipYear: 2025 } }));
        expect(link).toMatchObject({ checkoutUrl: expect.stringContaining('/cart/2025v:1'), unavailable: null });
    });

    it("a row stored without a year sells the live year at its creation, never today's", async () => {
        at(new Date(Date.UTC(2026, 6, 10, 12)));
        jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue({ ...awaiting, membershipYear: null } as never);
        variant.mockResolvedValue({ shopifyVariantId: '2025v' });
        await ensurePaymentLink(9);
        expect(variant).toHaveBeenCalledWith(expect.objectContaining({ where: { membershipYear: 2025 } }));
    });

    it('refuses an application whose year has ended', async () => {
        at(new Date(Date.UTC(2026, 8, 15, 12)));
        const link = await ensurePaymentLink(9);
        expect(link).toEqual({ amountCents: 5000, checkoutUrl: null, unavailable: 'This application is for 2025-2026, which has ended. Please contact the Board.' });
        expect(variant).not.toHaveBeenCalled();
    });

    it("gives no link, and never another year's, when the year has no product", async () => {
        at(new Date(Date.UTC(2026, 6, 10, 12)));
        variant.mockResolvedValue(null);
        const link = await ensurePaymentLink(9);
        expect(link).toMatchObject({ checkoutUrl: null, unavailable: "Payment for 2025-2026 isn't available right now. Please contact the Board." });
        expect(variant).toHaveBeenCalledTimes(1);
    });

    it('gives no link when the product is archived in Shopify', async () => {
        at(new Date(Date.UTC(2026, 6, 10, 12)));
        variant.mockResolvedValue({ shopifyVariantId: '2025v' });
        saleState.mockResolvedValue('archived');
        const link = await ensurePaymentLink(9);
        expect(link).toMatchObject({ checkoutUrl: null, unavailable: "Payment for 2025-2026 isn't available right now. Please contact the Board." });
    });

    it('says the store could not be reached, not that the product is retired, when the lookup fails', async () => {
        at(new Date(Date.UTC(2026, 6, 10, 12)));
        variant.mockResolvedValue({ shopifyVariantId: '2025v' });
        saleState.mockRejectedValue(new Error('timed out'));
        const link = await ensurePaymentLink(9);
        expect(link).toMatchObject({ checkoutUrl: null, unavailable: expect.stringContaining("couldn't reach the store") });
    });

    it('runs no lookup while the Shopify mock is active', async () => {
        at(new Date(Date.UTC(2026, 6, 10, 12)));
        mockActive.mockReturnValue(true);
        variant.mockResolvedValue(null);
        const link = await ensurePaymentLink(9);
        expect(link.checkoutUrl).toContain(`/cart/${DEV_MOCK_MEMBERSHIP_VARIANT_ID}:1`);
        expect(saleState).not.toHaveBeenCalled();
    });
});

describe('membershipProductProblems', () => {
    it('lists each running year an unpaid application is for whose product is missing or retired', async () => {
        at(new Date(Date.UTC(2026, 6, 10, 12)));
        jest.mocked(prisma.orgMembershipProcess.findMany).mockResolvedValue([
            { membershipYear: 2025, createdAt: new Date() },
            { membershipYear: 2026, createdAt: new Date() },
            { membershipYear: 2024, createdAt: new Date() },
        ] as never);
        variant.mockImplementation(({ where }: { where: { membershipYear: number } }) => (where.membershipYear === 2026 ? null : { shopifyVariantId: `${where.membershipYear}v` }));
        saleState.mockResolvedValue('archived');

        const problems = await membershipProductProblems();

        expect(problems).toEqual([
            { year: 2025, cause: 'retired', message: 'The 2025-2026 membership product is archived in Shopify. Families with a 2025-2026 application can\'t pay until it is restored.' },
            { year: 2026, cause: 'missing', message: expect.stringContaining('There is no 2026-2027 membership product') },
        ]);
    });

    it('reports a failed lookup as unreachable, never as retired', async () => {
        at(new Date(Date.UTC(2026, 6, 10, 12)));
        jest.mocked(prisma.orgMembershipProcess.findMany).mockResolvedValue([{ membershipYear: 2025, createdAt: new Date() }] as never);
        variant.mockResolvedValue({ shopifyVariantId: '2025v' });
        saleState.mockRejectedValue(new Error('timed out'));

        expect(await membershipProductProblems()).toEqual([expect.objectContaining({ year: 2025, cause: 'unreachable' })]);
    });

    it('lists nothing with no boundary set', async () => {
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: null } as never);
        expect(await membershipProductProblems()).toEqual([]);
        expect(prisma.orgMembershipProcess.findMany).not.toHaveBeenCalled();
    });
});
