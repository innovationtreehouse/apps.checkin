/**
 * @jest-environment node
 */
/**
 * PATCH /api/programs/[id] pushes a base-price change to both Shopify variants
 * (public + reserved-seat claimant) and never pushes $0. Real route, real DB,
 * real syncProgramPrice; only the Shopify HTTP calls (global fetch) are mocked.
 */

import { PATCH } from '@/app/api/programs/[id]/route';
import prisma from '@/lib/prisma';
import { resetTokenCache } from '@/lib/shopify/client';
import { sendEmail } from '@/lib/email';
import { logIntegrationError } from '@/lib/logger';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/logger', () => ({
    ...jest.requireActual('@/lib/logger'),
    logIntegrationError: jest.fn().mockResolvedValue(undefined),
}));

const TAG = 'Price Shopify Sync Test';

describe('PATCH /api/programs/[id] — Shopify price sync', () => {
    let adminId: number;
    let leadId: number;
    let fetchMock: jest.Mock;
    const originalFetch = global.fetch;
    const originalEnv = { ...process.env };

    beforeAll(async () => {
        const stale = await prisma.person.findMany({ where: { email: { contains: 'price-shopify-sync-test' } }, select: { id: true } });
        const staleIds = stale.map(u => u.id);
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: staleIds } } });
        await prisma.person.deleteMany({ where: { id: { in: staleIds } } });

        adminId = (await prisma.person.create({
            data: { email: 'admin-price-shopify-sync-test@example.com', name: 'Admin', isSysadmin: true, household: { create: { name: 'Test HH' } } },
        })).id;
        leadId = (await prisma.person.create({
            data: { email: 'lead-price-shopify-sync-test@example.com', name: 'Lead', isDeclaredAdult: true, household: { create: { name: 'Test HH' } } },
        })).id;
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        process.env = originalEnv;
        const ids = [adminId, leadId];
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
    });

    beforeEach(() => {
        delete process.env.CHECKIN_ENV; // Shopify mock off → the real HTTP path, against fetchMock
        process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
        process.env.SHOPIFY_CLIENT_ID = 'test_client_id';
        process.env.SHOPIFY_CLIENT_SECRET = 'test_client_secret';
        resetTokenCache();
        jest.clearAllMocks();
        fetchMock = jest.fn().mockImplementation(async (url: string) => String(url).includes('oauth')
            ? { ok: true, json: async () => ({ access_token: 'test_token', expires_in: 86400 }) }
            : { ok: true, json: async () => ({}) });
        global.fetch = fetchMock;
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
    });

    async function createProgram(suffix: string) {
        return prisma.program.create({
            data: {
                name: `${TAG} ${suffix}`, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'),
                orgMemberPriceCents: 8000, nonOrgMemberPriceCents: 10000,
                shopifyProductId: '501', shopifyVariantId: '601',
                claimantShopifyProductId: '502', claimantShopifyVariantId: '602',
            },
        });
    }

    async function patch(programId: number, body: Record<string, unknown>) {
        const req = new Request(`http://localhost:4000/api/programs/${programId}`, { method: 'PATCH', body: JSON.stringify(body) });
        return PATCH(req as unknown as Request, { params: Promise.resolve({ id: String(programId) }) });
    }

    const variantPuts = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/variants/'));

    it('pushes a changed base price to the public and the claimant variant', async () => {
        const program = await createProgram('changed');

        const res = await patch(program.id, { memberPrice: '80', nonMemberPrice: '125.50' });

        expect(res.status).toBe(200);
        expect((await res.json()).warning).toBeUndefined();
        const puts = variantPuts();
        expect(puts.map(([url]) => String(url))).toEqual([
            expect.stringContaining('/variants/601.json'),
            expect.stringContaining('/variants/602.json'),
        ]);
        for (const [, init] of puts) {
            expect(JSON.parse((init as RequestInit).body as string).variant.price).toBe('125.50');
        }
    });

    it('does not touch Shopify when only the member price changes', async () => {
        const program = await createProgram('member-only');

        const res = await patch(program.id, { memberPrice: '70', nonMemberPrice: '100' });

        expect(res.status).toBe(200);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('saves a $0 base but skips Shopify, warns, and alerts admins', async () => {
        const program = await createProgram('zero');

        const res = await patch(program.id, { nonMemberPrice: '0' });

        expect(res.status).toBe(200);
        expect((await res.json()).warning).toContain('Shopify price is out of date');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.any(Error), expect.objectContaining({ operation: 'syncProgramPrice', programId: program.id }));
        expect(sendEmail).toHaveBeenCalledWith('admin-price-shopify-sync-test@example.com', 'Shopify Integration Error', expect.stringContaining('out of date'));
        expect((await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).nonOrgMemberPriceCents).toBe(0);
    });

    it('never sends the member price when the full price is cleared', async () => {
        const program = await createProgram('cleared');

        const res = await patch(program.id, { memberPrice: '80', nonMemberPrice: '' });

        expect(res.status).toBe(200);
        expect((await res.json()).warning).toContain('Shopify price is out of date');
        expect(variantPuts()).toEqual([]); // no store write at all, so not the $80 member price
        expect(logIntegrationError).toHaveBeenCalledWith('shopify', expect.any(Error), expect.objectContaining({ operation: 'syncProgramPrice', programId: program.id }));
    });

    it('keeps the save and warns when Shopify rejects the update', async () => {
        const program = await createProgram('rejected');
        fetchMock.mockImplementation(async (url: string) => String(url).includes('oauth')
            ? { ok: true, json: async () => ({ access_token: 'test_token', expires_in: 86400 }) }
            : { ok: false, status: 500, text: async () => 'boom' });

        const res = await patch(program.id, { nonMemberPrice: '150' });

        expect(res.status).toBe(200);
        expect((await res.json()).warning).toContain('Shopify price is out of date');
        expect((await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).nonOrgMemberPriceCents).toBe(15000);
    });
});
