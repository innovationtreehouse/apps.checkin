/**
 * @jest-environment node
 *
 * PATCH /api/finance-ops/payments/[id]: a board member may not acknowledge or
 * resolve a payment problem about themselves or their own household — whether
 * the link is the exception's person, its membership process, or the order's
 * payer. withAuth is a passthrough so the handler sees the injected session.
 */
jest.mock('@/lib/auth', () => ({
    withAuth: (_opts: unknown, handler: (req: Request, auth: unknown, ctx: unknown) => unknown) =>
        (req: Request, auth: unknown, ctx: unknown) => handler(req, auth, ctx),
}));
jest.mock('@/lib/shopifyRead/client', () => ({ ordersByLegacyIds: jest.fn() }));

import { PATCH } from '../route';
import prisma from '@/lib/prisma';
import { ordersByLegacyIds } from '@/lib/shopifyRead/client';

const ACTOR_ID = 7;
const ACTOR_HOUSEHOLD = 2;
const OTHER_HOUSEHOLD = 9;

const ordersMock = ordersByLegacyIds as jest.Mock;
let householdById: Record<number, number>;
let exception: { personId: number | null; processId: number | null; shopifyOrderId: string | null };

beforeEach(() => {
    householdById = { [ACTOR_ID]: ACTOR_HOUSEHOLD, 20: OTHER_HOUSEHOLD, 21: ACTOR_HOUSEHOLD };
    exception = { personId: null, processId: null, shopifyOrderId: null };
    prisma.person.findUnique = jest.fn(async ({ where }: { where: { id: number } }) =>
        where.id in householdById ? { householdId: householdById[where.id] } : null,
    ) as jest.Mock;
    prisma.person.findFirst = jest.fn().mockResolvedValue(null);
    prisma.paymentException.findUnique = jest.fn(async () => exception) as jest.Mock;
    prisma.paymentException.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.orgMembershipProcess.findUnique = jest.fn().mockResolvedValue(null);
    prisma.auditLog.create = jest.fn().mockResolvedValue({});
    ordersMock.mockReset().mockResolvedValue([]);
});

function call(action = 'resolve') {
    const req = new Request('http://localhost/api/finance-ops/payments/5', {
        method: 'PATCH',
        body: JSON.stringify({ action, note: 'done' }),
    });
    const auth = { type: 'session', user: { id: ACTOR_ID, isBoardMember: true } };
    // The passthrough mock above takes (req, auth, ctx); the real wrapper's type takes (req, ctx).
    const handler = PATCH as unknown as (r: Request, a: unknown, c: unknown) => Promise<Response>;
    return handler(req, auth, { params: Promise.resolve({ id: '5' }) });
}

describe('PATCH /api/finance-ops/payments/[id] — own-household guard', () => {
    it('resolves an exception about another household', async () => {
        exception.personId = 20;
        const res = await call();
        expect(res.status).toBe(200);
        expect(prisma.paymentException.updateMany).toHaveBeenCalled();
    });

    it('refuses an exception about the actor', async () => {
        exception.personId = ACTOR_ID;
        const res = await call();
        expect(res.status).toBe(403);
        expect(prisma.paymentException.updateMany).not.toHaveBeenCalled();
    });

    it("refuses an exception about someone in the actor's household, for acknowledge too", async () => {
        exception.personId = 21;
        expect((await call('resolve')).status).toBe(403);
        expect((await call('acknowledge')).status).toBe(403);
        expect(prisma.paymentException.updateMany).not.toHaveBeenCalled();
    });

    it("refuses an exception on the actor's household's membership process", async () => {
        exception.processId = 3;
        (prisma.orgMembershipProcess.findUnique as jest.Mock).mockResolvedValue({
            orgMembership: { householdId: ACTOR_HOUSEHOLD },
            subjectPersonId: null,
        });
        expect((await call()).status).toBe(403);
    });

    it("refuses an exception whose background-check subject is in the actor's household", async () => {
        exception.processId = 3;
        (prisma.orgMembershipProcess.findUnique as jest.Mock).mockResolvedValue({ orgMembership: null, subjectPersonId: 21 });
        expect((await call()).status).toBe(403);
    });

    it('refuses when the actor is the order payer', async () => {
        exception.shopifyOrderId = '1001';
        ordersMock.mockResolvedValue([{ customerEmail: 'Me@Example.com' }]);
        (prisma.person.findFirst as jest.Mock).mockResolvedValue({ id: ACTOR_ID, householdId: ACTOR_HOUSEHOLD });
        expect((await call()).status).toBe(403);
    });

    it("allows an order paid by someone outside the actor's household", async () => {
        exception.shopifyOrderId = '1001';
        ordersMock.mockResolvedValue([{ customerEmail: 'other@example.com' }]);
        (prisma.person.findFirst as jest.Mock).mockResolvedValue({ id: 20, householdId: OTHER_HOUSEHOLD });
        expect((await call()).status).toBe(200);
    });

    it("refuses with 503 when the order's payer can't be read", async () => {
        exception.shopifyOrderId = '1001';
        ordersMock.mockRejectedValue(new Error('mirror down'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect((await call()).status).toBe(503);
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
        expect(prisma.paymentException.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an actor with no household', async () => {
        delete householdById[ACTOR_ID];
        exception.personId = 20;
        expect((await call()).status).toBe(403);
    });
});
