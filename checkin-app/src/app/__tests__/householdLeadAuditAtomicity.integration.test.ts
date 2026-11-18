/**
 * @jest-environment node
 */
/**
 * Removing a household lead and its audit row commit together: an audit write
 * that fails rolls the removal back, and the normal path writes both.
 */
import { DELETE } from '@/app/api/household/lead/route';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'lead-audit-atomicity-test';

/** Make every audit write throw, on the root client and inside a transaction. */
function breakAuditWrites() {
    const fail = () => { throw new Error('forced audit failure'); };
    jest.spyOn(prisma.auditLog, 'create').mockImplementation(fail as never);
    const realTransaction = prisma.$transaction.bind(prisma);
    const impl = (arg: unknown, opts?: unknown) => {
        if (typeof arg !== 'function') return (realTransaction as (a: unknown) => unknown)(arg);
        const fn = arg as (tx: unknown) => unknown;
        return (realTransaction as (cb: (tx: unknown) => unknown, o?: unknown) => unknown)((tx) => fn(new Proxy(tx as Record<string, unknown>, {
            get(target, prop) {
                if (prop === 'auditLog') return { create: fail };
                const value = target[prop as string];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        })), opts);
    };
    jest.spyOn(prisma, '$transaction').mockImplementation(impl as unknown as typeof prisma.$transaction);
}

function removeLead(participantId: number) {
    const req = new Request('http://localhost:4000/api/household/lead', {
        method: 'DELETE',
        body: JSON.stringify({ participantId }),
    });
    return DELETE(req as unknown as NextRequest);
}

describe('DELETE /api/household/lead — removal and audit row are atomic', () => {
    let householdId = 0;
    let actorId = 0;
    let removedId = 0;

    async function wipe() {
        const households = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = households.map((h) => h.id);
        if (!ids.length) return;
        const people = await prisma.person.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: people.map((p) => p.id) } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }

    beforeEach(async () => {
        await wipe();
        const household = await prisma.household.create({ data: { name: `${TAG} household` } });
        householdId = household.id;
        const actor = await prisma.person.create({
            data: { email: `actor-${TAG}@example.com`, name: 'Actor Lead', householdId, isHouseholdLead: true },
        });
        const removed = await prisma.person.create({
            data: { email: `removed-${TAG}@example.com`, name: 'Second Lead', householdId, isHouseholdLead: true },
        });
        actorId = actor.id;
        removedId = removed.id;
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: actorId } });
    });

    afterEach(() => jest.restoreAllMocks());
    afterAll(wipe);

    const auditRows = () => prisma.auditLog.count({
        where: { actorId, action: 'DELETE', tableName: 'Person', affectedEntityId: removedId },
    });
    const isLead = async () => (await prisma.person.findUniqueOrThrow({ where: { id: removedId } })).isHouseholdLead;

    it('rolls the removal back when the audit write fails', async () => {
        breakAuditWrites();
        const logged = jest.spyOn(logger, 'error').mockImplementation(() => {});
        const res = await removeLead(removedId);
        jest.restoreAllMocks();

        expect(res.status).toBe(500);
        expect(logged).toHaveBeenCalled();
        expect(await isLead()).toBe(true);
        expect(await auditRows()).toBe(0);
    });

    it('writes the removal and its audit row together', async () => {
        const res = await removeLead(removedId);

        expect(res.status).toBe(200);
        expect(await isLead()).toBe(false);
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { actorId, action: 'DELETE', tableName: 'Person', affectedEntityId: removedId },
        });
        expect(row).toMatchObject({
            actorSystem: null,
            secondaryAffectedEntity: householdId,
            oldData: { householdId, personId: removedId, isHouseholdLead: true },
        });
    });
});
