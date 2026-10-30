/**
 * @jest-environment node
 */
/**
 * Concurrency regression test for POST /api/programs/[id]/participants.
 *
 * Capacity used to be checked against a `_count` read when the program was
 * loaded, then the enrollment was created with no lock between. N concurrent
 * enrolls for the last seat all read count==max-1, all passed, all inserted —
 * overfilling the program past maxParticipants.
 *
 * The fix re-checks capacity under a Program-row FOR UPDATE lock INSIDE a
 * transaction immediately before the create. This test has one household lead
 * enroll two household members concurrently into a 1-seat program and asserts
 * exactly one succeeds and the program is not overfilled.
 *
 * (jest.setup.js gives this suite TEST_DB_POOL_MAX=2 so the two transactions
 * run on separate connections; the FOR UPDATE lock is then the only thing
 * serializing them, as in production.)
 */
import { POST } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn().mockResolvedValue(true),
}));

const TAG = 'partic-conc-test';

describe('POST /api/programs/[id]/participants concurrency (capacity lock)', () => {
    let leadId: number;
    let member1Id: number;
    let member2Id: number;
    let householdId: number;
    let programId: number;

    async function cleanup() {
        const users = await prisma.person.findMany({
            where: { email: { contains: TAG } },
            select: { id: true, householdId: true },
        });
        const ids = users.map(u => u.id);
        const householdIds = [...new Set(users.map(u => u.householdId))];
        await prisma.programParticipant.deleteMany({ where: { personId: { in: ids } } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    }

    beforeAll(async () => {
        await cleanup();

        const household = await prisma.household.create({ data: { name: `${TAG} household` } });
        householdId = household.id;

        const lead = await prisma.person.create({
            data: { email: `lead-${TAG}@example.com`, name: 'Lead', householdId },
        });
        leadId = lead.id;
        await prisma.person.update({ where: { id: leadId }, data: { isHouseholdLead: true } });

        const m1 = await prisma.person.create({
            data: { email: `m1-${TAG}@example.com`, name: 'Member One', householdId },
        });
        member1Id = m1.id;
        const m2 = await prisma.person.create({
            data: { email: `m2-${TAG}@example.com`, name: 'Member Two', householdId },
        });
        member2Id = m2.id;

        const program = await prisma.program.create({
            data: {
                appliesToYear: 2026,
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: `${TAG} program`,
                phase: 'RUNNING',
                enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'),
                maxParticipants: 1, // one seat
                orgMemberPriceCents: null,
                nonOrgMemberPriceCents: null, // free → no override needed, capacity still enforced
            },
        });
        programId = program.id;

        // Lead is the actor for both enrollments (household-lead authorization).
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
    });

    afterAll(cleanup);

    const params = (id: number) => ({ params: Promise.resolve({ id: id.toString() }) });

    function enroll(participantId: number) {
        return new Request(`http://localhost:4000/api/programs/${programId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId }),
        });
    }

    it('two concurrent enrolls for the last seat → exactly one succeeds, no overfill', async () => {
        const [resA, resB] = await Promise.all([
            POST(enroll(member1Id) as unknown as import('next/server').NextRequest, params(programId) as unknown as never),
            POST(enroll(member2Id) as unknown as import('next/server').NextRequest, params(programId) as unknown as never),
        ]);

        const statuses = [resA.status, resB.status].sort();
        // Exactly one 200, one 400 — never two 200s.
        expect(statuses).toEqual([200, 400]);

        const loser = resA.status === 400 ? resA : resB;
        expect((await loser.json()).error).toMatch(/maximum capacity/i);

        // The core invariant: at most one enrollment exists.
        const enrolled = await prisma.programParticipant.count({ where: { programId } });
        expect(enrolled).toBe(1);
    });
});
