/**
 * @jest-environment node
 */
/**
 * Guard: a CLOSED program rejects new enrollments on the authenticated
 * self-enroll path (POST /api/programs/[id]/participants). It checks
 * enrollmentStatus === 'CLOSED' and returns 400; this was untested.
 */
import { POST as ENROLL } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn().mockResolvedValue(true) }));

const TAG = 'enroll-closed-test';

describe('Enroll into a CLOSED program is rejected', () => {
    let userId: number;
    let closedProgramId: number;

    async function cleanup() {
        const progs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const progIds = progs.map(p => p.id);
        await prisma.programParticipant.deleteMany({ where: { programId: { in: progIds } } });
        // Households reached via enrolled members + the test user.
        const members = await prisma.person.findMany({ where: { OR: [{ email: { contains: TAG } }, { programParticipants: { some: { programId: { in: progIds } } } }] }, select: { id: true, householdId: true } });
        const hhIds = [...new Set(members.map(m => m.householdId).filter((x): x is number => x != null))];
        await prisma.auditLog.deleteMany({ where: { actorId: { in: members.map(m => m.id) } } });
        await prisma.emergencyContact.deleteMany({ where: { householdId: { in: hhIds } } });
        await prisma.person.deleteMany({ where: { householdId: { in: hhIds } } });
        await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
        await prisma.program.deleteMany({ where: { id: { in: progIds } } });
    }

    beforeAll(async () => {
        await cleanup();
        const user = await prisma.person.create({ data: { email: `user-${TAG}@example.com`, name: 'Self Enroller', household: { create: { name: "Test HH" } } } });
        userId = user.id;
        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Closed ${TAG}`, phase: 'RUNNING', enrollmentStatus: 'CLOSED', orgMemberPriceCents: null, nonOrgMemberPriceCents: null },
        });
        closedProgramId = program.id;
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    const params = (id: number) => ({ params: Promise.resolve({ id: id.toString() }) });

    it('authenticated self-enroll into a CLOSED program → 400 closed', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: userId } });
        const req = new Request(`http://localhost:4000/api/programs/${closedProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: userId }),
        });
        const res = await ENROLL(req as unknown as import('next/server').NextRequest, params(closedProgramId) as unknown as never);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/closed/i);
        // No enrollment row written.
        expect(await prisma.programParticipant.count({ where: { programId: closedProgramId } })).toBe(0);
    });

    it('refuses a new claim once the off-sale date has arrived, before the daily sweep closes it', async () => {
        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2099-12-31'), name: `Sale Ended ${TAG}`, phase: 'RUNNING', enrollmentStatus: 'OPEN', orgMemberPriceCents: null, nonOrgMemberPriceCents: null },
        });
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: userId } });
        const req = new Request(`http://localhost:4000/api/programs/${program.id}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: userId }),
        });
        const res = await ENROLL(req as unknown as import('next/server').NextRequest, params(program.id) as unknown as never);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/sales .* ended/i);
        expect(await prisma.programParticipant.count({ where: { programId: program.id } })).toBe(0);
    });

    it('still sends a claim made in time back to its checkout after the sale ended', async () => {
        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2099-12-31'), name: `Sale Ended Claim ${TAG}`, phase: 'RUNNING', enrollmentStatus: 'OPEN', orgMemberPriceCents: null, nonOrgMemberPriceCents: null },
        });
        await prisma.programParticipant.create({ data: { programId: program.id, personId: userId, status: 'PENDING' } });
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: userId } });
        const req = new Request(`http://localhost:4000/api/programs/${program.id}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: userId }),
        });
        const res = await ENROLL(req as unknown as import('next/server').NextRequest, params(program.id) as unknown as never);
        expect(res.status).toBe(409);
    });
});
