/**
 * @jest-environment node
 */
/**
 * A claim and a capacity cut both judge capacity, and a claim judges the phase,
 * on the Program row read under its lock. Each test holds that lock in its own
 * transaction, starts the other side so it queues behind the lock, commits a
 * change, and checks the waiting side saw it. The program never ends over its
 * cap, and an ended program takes no claim.
 */
import { POST } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { updateProgram } from '@/lib/programs/update';
import { WITH_EMERGENCY_CONTACT } from '@/test-helpers/emergencyContact';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn().mockResolvedValue(true) }));

const TAG = 'cap-phase-lock-test';
const board = { id: 0, isSysadmin: false, isBoardMember: true };

/** Long enough for the other side to reach the lock and wait on it. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe('capacity and phase are judged under the Program lock', () => {
    let leadId: number;
    let seatedId: number;
    let claimantId: number;
    let householdId: number;
    let programId: number;

    async function cleanup() {
        const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const ids = people.map((p) => p.id);
        await prisma.programParticipant.deleteMany({ where: { personId: { in: ids } } });
        const programs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: [...ids, board.id] }, tableName: 'Program', affectedEntityId: { in: programs.map((p) => p.id) } }, { actorId: { in: ids } }] } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: [...new Set(people.map((p) => p.householdId))] } } });
    }

    beforeAll(async () => {
        await cleanup();
        householdId = (await prisma.household.create({ data: { name: `${TAG} household`, ...WITH_EMERGENCY_CONTACT } })).id;
        leadId = (await prisma.person.create({ data: { email: `lead-${TAG}@example.com`, name: 'Lead', householdId, isHouseholdLead: true, isDeclaredAdult: true } })).id;
        seatedId = (await prisma.person.create({ data: { email: `seated-${TAG}@example.com`, name: 'Seated', householdId } })).id;
        claimantId = (await prisma.person.create({ data: { email: `claimant-${TAG}@example.com`, name: 'Claimant', householdId } })).id;
        board.id = (await prisma.person.create({ data: { email: `board-${TAG}@example.com`, name: 'Board', householdId: (await prisma.household.create({ data: { name: `${TAG} board household` } })).id } })).id;
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
    });

    beforeEach(async () => {
        await prisma.programParticipant.deleteMany({ where: { personId: { in: [seatedId, claimantId] } } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        // Free and open, cap 2, one place already taken.
        programId = (await prisma.program.create({
            data: {
                appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'),
                name: `${TAG} program`, phase: 'RUNNING', enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'),
                maxParticipants: 2,
                participants: { create: { personId: seatedId, status: 'ACTIVE' } },
            },
        })).id;
    });

    afterAll(cleanup);

    const claim = () => POST(
        new Request(`http://localhost:4000/api/programs/${programId}/participants`, { method: 'POST', body: JSON.stringify({ participantId: claimantId }) }) as unknown as import('next/server').NextRequest,
        { params: Promise.resolve({ id: String(programId) }) } as unknown as never,
    );

    /** Hold the Program lock, start `waiter`, run `change` while it waits, then commit. */
    async function underHeldLock<T>(waiter: () => Promise<T>, change: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>): Promise<T> {
        let pending!: Promise<T>;
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Program" WHERE id = ${programId} FOR UPDATE`;
            pending = waiter();
            await settle();
            await change(tx);
        }, { timeout: 10_000 });
        return pending;
    }

    it('a claim waiting on a capacity cut is judged against the new cap, not the one it read', async () => {
        const res = await underHeldLock(claim, (tx) => tx.program.update({ where: { id: programId }, data: { maxParticipants: 1 } }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/maximum capacity/i);
        expect(await prisma.programParticipant.count({ where: { programId, status: { not: 'WITHDRAWN' } } })).toBe(1);
    });

    it('a capacity cut waiting on a claim counts the place the claim took', async () => {
        const read = await prisma.program.findUniqueOrThrow({ where: { id: programId } });
        const result = await underHeldLock(
            () => updateProgram(read, { maxParticipants: 1 }, board),
            (tx) => tx.programParticipant.create({ data: { programId, personId: claimantId, status: 'ACTIVE' } }),
        );
        expect(result).toMatchObject({ ok: false, refusal: 'invalid', message: expect.stringContaining('current enrollment of 2') });
        expect((await prisma.program.findUniqueOrThrow({ where: { id: programId } })).maxParticipants).toBe(2);
    });

    it('a claim waiting on the program ending is refused', async () => {
        const res = await underHeldLock(claim, (tx) => tx.program.update({ where: { id: programId }, data: { phase: 'FINISHED', enrollmentStatus: 'CLOSED' } }));
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/has ended/);
        expect(await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId: claimantId } } })).toBeNull();
    });

    it('opening enrollment waiting on the program ending is refused', async () => {
        await prisma.program.update({ where: { id: programId }, data: { enrollmentStatus: 'CLOSED' } });
        const read = await prisma.program.findUniqueOrThrow({ where: { id: programId } });
        const result = await underHeldLock(
            () => updateProgram(read, { enrollmentStatus: 'OPEN' }, board),
            (tx) => tx.program.update({ where: { id: programId }, data: { phase: 'FINISHED' } }),
        );
        expect(result).toMatchObject({ ok: false, refusal: 'conflict' });
        expect(await prisma.program.findUniqueOrThrow({ where: { id: programId } })).toMatchObject({ phase: 'FINISHED', enrollmentStatus: 'CLOSED' });
    });
});
