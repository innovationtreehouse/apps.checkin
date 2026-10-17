/**
 * @jest-environment node
 */
/**
 * Guard: a priced program with no Shopify variant (isProgramCheckoutBroken)
 * rejects any payment-bound enrollment on POST /api/programs/[id]/participants,
 * because the seat would sit PENDING with nothing to pay through. An external
 * admin's confirmed override is a comp (ACTIVE, no payment) and still goes in.
 */
import { POST as ENROLL } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn().mockResolvedValue(true) }));

const TAG = 'enroll-checkout-broken-test';

describe('Enroll into a priced-but-unsellable program is rejected', () => {
    let userId: number;
    let adminId: number;
    let brokenProgramId: number;
    let sellableProgramId: number;
    let zeroPricedProgramId: number;

    async function cleanup() {
        const progs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const progIds = progs.map(p => p.id);
        await prisma.programParticipant.deleteMany({ where: { programId: { in: progIds } } });
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
        const user = await prisma.person.create({
            data: { email: `user-${TAG}@example.com`, name: 'Self Enroller', isDeclaredAdult: true, household: { create: { name: `HH ${TAG}` } } },
        });
        userId = user.id;
        const admin = await prisma.person.create({
            data: { email: `admin-${TAG}@example.com`, name: 'Board Admin', isDeclaredAdult: true, isBoardMember: true, household: { create: { name: `Admin HH ${TAG}` } } },
        });
        adminId = admin.id;
        const broken = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Broken ${TAG}`, phase: 'RUNNING', enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), nonOrgMemberPriceCents: 5000, shopifyVariantId: null },
        });
        brokenProgramId = broken.id;
        const sellable = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Sellable ${TAG}`, phase: 'RUNNING', enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), nonOrgMemberPriceCents: 5000, shopifyVariantId: 'gid://shopify/ProductVariant/1' },
        });
        sellableProgramId = sellable.id;
        const zeroPriced = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Zero ${TAG}`, phase: 'RUNNING', enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), orgMemberPriceCents: 0, nonOrgMemberPriceCents: 0, shopifyVariantId: null },
        });
        zeroPricedProgramId = zeroPriced.id;
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    const params = (id: number) => ({ params: Promise.resolve({ id: id.toString() }) });

    async function enroll(programId: number, actor: Record<string, unknown>, participantId: number, body: Record<string, unknown> = {}) {
        (getServerSession as jest.Mock).mockResolvedValue({ user: actor });
        const req = new Request(`http://localhost:4000/api/programs/${programId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId, ...body }),
        });
        return ENROLL(req as unknown as import('next/server').NextRequest, params(programId) as unknown as never);
    }

    it('self-enroll into a priced program with no variant → 400, no row', async () => {
        const res = await enroll(brokenProgramId, { id: userId }, userId);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/payment link/i);
        expect(data.requiresOverride).toBeUndefined();
        expect(await prisma.programParticipant.count({ where: { programId: brokenProgramId } })).toBe(0);
    });

    it('an admin comp (external, confirmed override) still enrolls ACTIVE', async () => {
        const res = await enroll(brokenProgramId, { id: adminId, isBoardMember: true }, userId, { override: true });
        expect(res.status).toBe(200);
        const row = await prisma.programParticipant.findFirst({ where: { programId: brokenProgramId, personId: userId } });
        expect(row?.status).toBe('ACTIVE');
    });

    it('a zero-priced program is free: enrolls ACTIVE, never waits on a payment', async () => {
        const res = await enroll(zeroPricedProgramId, { id: userId }, userId);
        expect(res.status).toBe(200);
        const row = await prisma.programParticipant.findFirst({ where: { programId: zeroPricedProgramId, personId: userId } });
        expect(row?.status).toBe('ACTIVE');
    });

    it('a sellable priced program still enrolls PENDING', async () => {
        const res = await enroll(sellableProgramId, { id: userId }, userId);
        expect(res.status).toBe(200);
        const row = await prisma.programParticipant.findFirst({ where: { programId: sellableProgramId, personId: userId } });
        expect(row?.status).toBe('PENDING');
    });
});
