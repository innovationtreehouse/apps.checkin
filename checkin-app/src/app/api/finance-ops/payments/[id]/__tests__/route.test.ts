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
jest.mock('@/lib/shopifyRead/client', () => ({
    ordersByLegacyIds: jest.fn(),
    orderAttr: (o: { noteAttributes?: { key: string; value: string }[] | null }, key: string) =>
        o.noteAttributes?.find((a) => a.key === key)?.value ?? null,
}));

import { PATCH } from '../route';
import prisma from '@/lib/prisma';
import { ordersByLegacyIds } from '@/lib/shopifyRead/client';
import { SELF_GRANT_REFUSAL_TABLE } from '@/lib/membership/selfGrantGuard';

const ACTOR_ID = 7;
const ACTOR_HOUSEHOLD = 2;
const OTHER_HOUSEHOLD = 9;

const ordersMock = ordersByLegacyIds as jest.Mock;
let householdById: Record<number, number>;
let mergedIntoById: Record<number, number>;
let exception: { personId: number | null; processId: number | null; shopifyOrderId: string | null };

beforeEach(() => {
    householdById = { [ACTOR_ID]: ACTOR_HOUSEHOLD, 20: OTHER_HOUSEHOLD, 21: ACTOR_HOUSEHOLD, 22: OTHER_HOUSEHOLD };
    mergedIntoById = {};
    exception = { personId: null, processId: null, shopifyOrderId: null };
    prisma.person.findUnique = jest.fn(async ({ where }: { where: { id: number } }) =>
        where.id in householdById ? { householdId: householdById[where.id], mergedIntoId: mergedIntoById[where.id] ?? null } : null,
    ) as jest.Mock;
    prisma.person.findMany = jest.fn().mockResolvedValue([]);
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

    it('refuses an exception about the actor and audits the refusal', async () => {
        exception.personId = ACTOR_ID;
        const res = await call();
        expect(res.status).toBe(403);
        expect(prisma.paymentException.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect((prisma.auditLog.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
            actorId: ACTOR_ID,
            tableName: SELF_GRANT_REFUSAL_TABLE,
            newData: { reason: 'own_household', table: 'PaymentException', attempted: { action: 'resolve' } },
        });
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
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ id: ACTOR_ID, email: 'me@example.com' }]);
        expect((await call()).status).toBe(403);
    });

    it("allows an order paid by someone outside the actor's household", async () => {
        exception.shopifyOrderId = '1001';
        ordersMock.mockResolvedValue([{ customerEmail: 'other@example.com' }]);
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ id: ACTOR_ID, email: 'me@example.com' }]);
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

    it("refuses when the exception's person was merged into someone in the actor's household", async () => {
        exception.personId = 22;
        mergedIntoById = { 22: 21 };
        expect((await call()).status).toBe(403);
    });

    it("refuses when any child the order names is in the actor's household, not just the recorded one", async () => {
        exception.personId = 20;
        exception.shopifyOrderId = '1001';
        ordersMock.mockResolvedValue([{ customerEmail: 'other@example.com', noteAttributes: [{ key: 'CheckMeIn_Account_ID', value: '20, 21' }] }]);
        expect((await call()).status).toBe(403);
    });

    it("allows when every child the order names is outside the actor's household", async () => {
        exception.personId = 20;
        exception.shopifyOrderId = '1001';
        ordersMock.mockResolvedValue([{ customerEmail: 'other@example.com', noteAttributes: [{ key: 'CheckMeIn_Account_ID', value: '20,22' }] }]);
        expect((await call()).status).toBe(200);
    });

    it('refuses an actor with no household', async () => {
        delete householdById[ACTOR_ID];
        exception.personId = 20;
        expect((await call()).status).toBe(403);
    });
});
