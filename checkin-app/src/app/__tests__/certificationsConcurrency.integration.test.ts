/**
 * @jest-environment node
 */
/**
 * A certifier's level change races the Board making the same target a
 * certifier. The certifier's write must not overwrite the new certifier level:
 * the route compares-and-sets on the level it read, so the losing write gets a
 * 409 and changes nothing.
 *
 * Made deterministic by holding the Board's update uncommitted on one
 * connection until the certifier's write is blocked on that row lock.
 */
import { POST } from '@/app/api/shop/certifications/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'cert-concurrency-test';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function postReq(body: Record<string, unknown>) {
    return {
        url: 'http://localhost:4000/api/shop/certifications',
        method: 'POST',
        headers: { get: () => null },
        json: jest.fn().mockResolvedValue(body),
    } as unknown as never;
}

describe('certification level change racing a certifier grant (real DB)', () => {
    let toolId: number;
    let certifierId: number;
    let targetId: number;
    const householdIds: number[] = [];

    beforeAll(async () => {
        toolId = (await prisma.tool.create({ data: { name: `Tool ${TAG}` } })).id;
        const certifier = await prisma.person.create({
            data: {
                email: `certifier-${TAG}@example.com`, name: 'Race Certifier',
                household: { create: { name: 'Test HH', orgMembership: { create: { status: 'ACTIVE' } } } },
                toolStatuses: { create: { toolId, level: 'MAY_CERTIFY_OTHERS' } },
            },
        });
        const target = await prisma.person.create({
            data: {
                email: `target-${TAG}@example.com`, name: 'Race Target',
                household: { create: { name: 'Test HH', orgMembership: { create: { status: 'ACTIVE' } } } },
                toolStatuses: { create: { toolId, level: 'CERTIFIED' } },
            },
        });
        certifierId = certifier.id;
        targetId = target.id;
        householdIds.push(certifier.householdId, target.householdId);
    });

    afterAll(async () => {
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [certifierId, targetId] } } });
        await prisma.toolStatus.deleteMany({ where: { toolId } });
        await prisma.tool.deleteMany({ where: { id: toolId } });
        await prisma.person.deleteMany({ where: { id: { in: [certifierId, targetId] } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('refuses the certifier write with 409 and keeps the certifier level', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: certifierId } });

        const race: { pending?: Promise<Response> } = {};
        await prisma.$transaction(async (tx) => {
            await tx.toolStatus.update({
                where: { personId_toolId: { personId: targetId, toolId } },
                data: { level: 'MAY_CERTIFY_OTHERS' },
            });
            race.pending = POST(postReq({ personId: targetId, toolId, level: 'BASIC' })) as Promise<Response>;

            const deadline = Date.now() + 10_000;
            for (;;) {
                const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
                    SELECT count(*)::int AS n FROM pg_stat_activity
                    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
                if (n > 0) break;
                if (Date.now() > deadline) throw new Error('certifier write never blocked on the row lock');
                await sleep(20);
            }
        }, { timeout: 15_000 });

        if (!race.pending) throw new Error('certifier write never started');
        const res = await race.pending;
        expect(res.status).toBe(409);

        const row = await prisma.toolStatus.findUnique({ where: { personId_toolId: { personId: targetId, toolId } } });
        expect(row?.level).toBe('MAY_CERTIFY_OTHERS');
        const writes = await prisma.auditLog.findMany({ where: { actorId: certifierId, tableName: 'ToolStatus' } });
        expect(writes).toHaveLength(0);
    });
});
