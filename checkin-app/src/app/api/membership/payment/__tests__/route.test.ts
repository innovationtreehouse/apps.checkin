/**
 * @jest-environment node
 *
 * GET /api/membership/payment returns the finance contact address setting beside the
 * fee, or null when it is unset. withAuth is a passthrough so the handler sees the
 * injected session.
 */
jest.mock('@/lib/auth', () => ({
    withAuth: (_opts: unknown, handler: (req: Request, auth: unknown) => unknown) =>
        (req: Request, auth: unknown) => handler(req, auth),
}));
jest.mock('@/lib/household/leads', () => ({ householdLeadship: jest.fn().mockResolvedValue({ canManage: true }) }));
jest.mock('@/lib/membership/payment', () => ({
    ensurePaymentLinkForUser: jest.fn().mockResolvedValue({ amountCents: 12500, checkoutUrl: 'https://shop.example/checkout' }),
    PaymentError: class PaymentError extends Error {},
}));

import { GET } from '../route';
import prisma from '@/lib/prisma';

type Get = (req: Request, auth: unknown) => Promise<Response>;
const SESSION = { type: 'session', user: { id: 7, isBoardMember: false } };
const get = (auth: unknown = SESSION) => (GET as unknown as Get)(new Request('http://localhost/api/membership/payment'), auth);

describe('GET /api/membership/payment finance contact', () => {
    it('refuses a caller without a session', async () => {
        prisma.boardSettings.findUnique = jest.fn();
        const res = await get({ type: 'kiosk' });
        expect(res.status).toBe(401);
        expect(prisma.boardSettings.findUnique).not.toHaveBeenCalled();
    });

    it.each([
        [{ financeContactEmail: ' finance@example.org ' }, 'finance@example.org'],
        [{ financeContactEmail: null }, null],
        [{ financeContactEmail: '' }, null],
        [{ financeContactEmail: '  ' }, null],
        [null, null],
    ])('returns %o as %p', async (row, expected) => {
        prisma.boardSettings.findUnique = jest.fn().mockResolvedValue(row);
        const res = await get();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ amountCents: 12500, checkoutUrl: 'https://shop.example/checkout', financeContactEmail: expected });
    });
});
