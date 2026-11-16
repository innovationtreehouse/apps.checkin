/**
 * @jest-environment node
 */
/**
 * A program edit and its audit row commit together: when the audit insert fails,
 * the edit rolls back with it. The transaction's `tx.auditLog.create` is made to
 * throw; an edit written before a separate audit save would stay committed.
 */
import prisma from '@/lib/prisma';
import { updateProgram } from '@/lib/programs/update';

const TAG = 'program-edit-audit-atomic-test';

function breakAuditInTransaction() {
    const realTransaction = prisma.$transaction.bind(prisma);
    const impl = (fn: (tx: unknown) => unknown) =>
        (realTransaction as (cb: (tx: unknown) => unknown) => unknown)((tx) => fn(new Proxy(tx as Record<string, unknown>, {
            get(target, prop) {
                if (prop === 'auditLog') return { create: () => { throw new Error('forced audit failure'); } };
                return target[prop as string];
            },
        })));
    return jest.spyOn(prisma, '$transaction').mockImplementation(impl as unknown as typeof prisma.$transaction);
}

describe('program edit — change and audit are atomic', () => {
    let actorId = 0;
    let programId = 0;

    async function wipe() {
        const programs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = programs.map((p) => p.id);
        await prisma.auditLog.deleteMany({ where: { tableName: 'Program', affectedEntityId: { in: ids } } });
        await prisma.program.deleteMany({ where: { id: { in: ids } } });
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();
        const actor = await prisma.person.create({
            data: { name: 'Board', email: `board-${TAG}@example.com`, household: { create: { name: `HH ${TAG}` } } },
        });
        actorId = actor.id;
        const program = await prisma.program.create({
            data: { name: `Before ${TAG}`, appliesToYear: 2026, startAt: new Date('2026-09-01'), endAt: new Date('2026-12-01'), leadMentorId: actor.id },
        });
        programId = program.id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    afterEach(() => jest.restoreAllMocks());

    it('a failing audit rolls back the rename and leaves no audit row', async () => {
        const current = await prisma.program.findUniqueOrThrow({ where: { id: programId } });

        breakAuditInTransaction();
        await expect(
            updateProgram(current, { name: `After ${TAG}` }, { id: actorId, isSysadmin: true, isBoardMember: true }),
        ).rejects.toThrow('forced audit failure');
        jest.restoreAllMocks();

        expect((await prisma.program.findUniqueOrThrow({ where: { id: programId } })).name).toBe(`Before ${TAG}`);
        expect(await prisma.auditLog.count({ where: { tableName: 'Program', affectedEntityId: programId } })).toBe(0);
    });
});
