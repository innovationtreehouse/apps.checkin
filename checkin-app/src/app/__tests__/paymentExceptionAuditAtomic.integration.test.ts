/**
 * @jest-environment node
 */
/**
 * Resolving a payment exception and its audit row commit together: when the
 * audit write fails, the exception stays as it was.
 */

import { PATCH } from '@/app/api/finance-ops/payments/[id]/route';
import prisma from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'payment-exception-audit-atomic-test';

const resolve = (id: number) =>
    (PATCH as unknown as (req: Request, ctx: unknown) => Promise<Response>)(
        new Request(`http://localhost:4000/api/finance-ops/payments/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ action: 'resolve', note: TAG }),
        }),
        { params: Promise.resolve({ id: String(id) }) },
    );

/** Make every audit write throw: on the root client and inside any transaction. */
function breakAuditWrites() {
    const fail = () => Promise.reject(new Error('forced audit failure'));
    const root = jest.spyOn(prisma.auditLog, 'create').mockImplementation(fail as unknown as typeof prisma.auditLog.create);
    const realTransaction = prisma.$transaction.bind(prisma) as (fn: (tx: Prisma.TransactionClient) => unknown) => unknown;
    const tx = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: Prisma.TransactionClient) => unknown) =>
        realTransaction((client) =>
            fn(new Proxy(client, { get: (target, prop) => (prop === 'auditLog' ? { create: fail } : Reflect.get(target, prop)) })),
        )) as unknown as typeof prisma.$transaction);
    return () => {
        root.mockRestore();
        tx.mockRestore();
    };
}

describe('PATCH /api/finance-ops/payments/[id] — exception and audit commit together', () => {
    let boardId: number;
    let householdId: number;

    const openException = async () =>
        (await prisma.paymentException.create({ data: { kind: 'ACTIVE_WITHOUT_PAYMENT', severity: 'WARN', evidence: TAG } })).id;

    async function wipe() {
        await prisma.paymentException.deleteMany({ where: { evidence: TAG } });
        if (boardId) await prisma.auditLog.deleteMany({ where: { actorId: boardId } });
    }

    beforeAll(async () => {
        const household = await prisma.household.create({ data: { name: `Board ${TAG}` } });
        householdId = household.id;
        boardId = (await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, householdId },
        })).id;
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true, isSysadmin: false } });
    });

    afterEach(wipe);

    afterAll(async () => {
        await wipe();
        await prisma.person.deleteMany({ where: { id: boardId } });
        await prisma.household.deleteMany({ where: { id: householdId } });
        await prisma.$disconnect();
    });

    it('leaves the exception open when its audit write fails', async () => {
        const id = await openException();
        const restore = breakAuditWrites();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect((await resolve(id)).status).toBe(500);
        } finally {
            restore();
            errorSpy.mockRestore();
        }
        const row = await prisma.paymentException.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject({ status: 'OPEN', resolvedById: null, resolutionNote: null });
        expect(await prisma.auditLog.count({ where: { tableName: 'PaymentException', affectedEntityId: id } })).toBe(0);
    });

    it('resolves the exception and writes its audit row', async () => {
        const id = await openException();
        expect((await resolve(id)).status).toBe(200);
        const row = await prisma.paymentException.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject({ status: 'RESOLVED', resolvedById: boardId, resolutionNote: TAG });
        const audit = await prisma.auditLog.findMany({ where: { tableName: 'PaymentException', affectedEntityId: id } });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actorId: boardId, actorSystem: null, action: 'EDIT' });
    });
});
