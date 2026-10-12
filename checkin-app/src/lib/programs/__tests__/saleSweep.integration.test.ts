/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { runSaleSweep } from '@/lib/programs/saleSweep';
import { withdrawAndReleaseHold } from '@/lib/program/capacity';
import { setProgramProductOffSale, adjustProgramInventory } from '@/lib/shopify';
import { emailBoardMembers } from '@/lib/emailRecipients';

jest.mock('@/lib/shopify', () => ({
    setProgramProductOffSale: jest.fn().mockResolvedValue(true),
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'Sale Sweep Test';
const HH = 'Sale Sweep Test HH';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-12T09:15:00Z');
const day = (s: string) => new Date(`${s}T00:00:00Z`);

const offSale = jest.mocked(setProgramProductOffSale);
const adjust = jest.mocked(adjustProgramInventory);
const emailBoard = jest.mocked(emailBoardMembers);

async function mkProgram(name: string, data: Partial<{ startAt: Date; offSaleAt: Date | null; phase: 'UPCOMING' | 'FINISHED'; saleEndedAt: Date }>) {
    return prisma.program.create({
        data: {
            name: `${TAG} ${name}`,
            startAt: data.startAt ?? day('2026-11-01'),
            endAt: day('2026-12-31'),
            offSaleAt: data.offSaleAt ?? null,
            phase: data.phase ?? 'UPCOMING',
            enrollmentStatus: 'OPEN',
            shopifyProductId: `prod-${name}`,
            shopifyVariantId: `var-${name}`,
            saleEndedAt: data.saleEndedAt ?? null,
        },
    });
}

async function cleanup() {
    const programs = await prisma.program.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await prisma.programParticipant.deleteMany({ where: { programId: { in: programs.map((p) => p.id) } } });
    await prisma.program.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.person.deleteMany({ where: { email: { contains: 'sale-sweep-test' } } });
    await prisma.household.deleteMany({ where: { name: HH } });
}

describe('program sale sweep', () => {
    beforeEach(async () => {
        await cleanup();
        jest.clearAllMocks();
    });
    afterAll(cleanup);

    it('ends due sales once and closes enrollment, leaving the store product on sale; leaves future and finished programs alone', async () => {
        const due = await mkProgram('due', { startAt: day('2026-10-12') });
        const early = await mkProgram('early', { startAt: day('2026-11-01'), offSaleAt: day('2026-10-05') });
        const future = await mkProgram('future', { startAt: day('2026-10-01'), offSaleAt: day('2026-10-20') });
        const finished = await mkProgram('finished', { startAt: day('2026-01-01'), phase: 'FINISHED' });

        await runSaleSweep(NOW);

        const after = await prisma.program.findMany({ where: { id: { in: [due.id, early.id, future.id, finished.id] } } });
        const byId = new Map(after.map((p) => [p.id, p]));
        for (const p of [due, early]) {
            expect(byId.get(p.id)!.saleEndedAt).toEqual(NOW);
            expect(byId.get(p.id)!.enrollmentStatus).toBe('CLOSED');
        }
        for (const p of [future, finished]) {
            expect(byId.get(p.id)!.saleEndedAt).toBeNull();
            expect(byId.get(p.id)!.enrollmentStatus).toBe('OPEN');
        }
        // Claimants still pay through the public product, so it is never taken off sale yet.
        expect(offSale).not.toHaveBeenCalled();

        const later = new Date(NOW.getTime() + DAY_MS);
        await runSaleSweep(later);
        expect((await prisma.program.findUniqueOrThrow({ where: { id: due.id } })).saleEndedAt).toEqual(NOW);
    });

    it('emails the board unpaid claims a week after the sale ended, once per program', async () => {
        const program = await mkProgram('unpaid', { startAt: day('2026-10-01'), saleEndedAt: new Date(NOW.getTime() - 7 * DAY_MS) });
        const recent = await mkProgram('recent', { startAt: day('2026-10-10'), saleEndedAt: new Date(NOW.getTime() - 2 * DAY_MS) });
        const kid = await prisma.person.create({ data: { name: 'Unpaid Kid', email: 'kid-sale-sweep-test@example.com', household: { create: { name: HH } } } });
        const paid = await prisma.person.create({ data: { name: 'Paid Kid', email: 'paid-sale-sweep-test@example.com', household: { create: { name: HH } } } });
        await prisma.programParticipant.createMany({
            data: [
                { programId: program.id, personId: kid.id, status: 'PENDING' },
                { programId: program.id, personId: paid.id, status: 'ACTIVE' },
                { programId: recent.id, personId: kid.id, status: 'PENDING' },
            ],
        });

        await runSaleSweep(NOW);
        await runSaleSweep(NOW);

        expect(emailBoard).toHaveBeenCalledTimes(1);
        const [subject, html] = emailBoard.mock.calls[0];
        expect(subject).toContain(`${TAG} unpaid`);
        expect(html).toContain('Unpaid Kid');
        expect(html).not.toContain('Paid Kid');
        expect((await prisma.program.findUniqueOrThrow({ where: { id: recent.id } })).unpaidClaimsNotifiedAt).toBeNull();
    });

    it('does not put a withdrawn held seat back on sale after the sale ended', async () => {
        const kid = await prisma.person.create({ data: { name: 'Held Kid', email: 'held-sale-sweep-test@example.com', household: { create: { name: HH } } } });
        const ended = await mkProgram('ended', { startAt: day('2020-01-01') });
        const open = await mkProgram('open', { startAt: day('2099-01-01') });
        for (const p of [ended, open]) {
            await prisma.programParticipant.create({
                data: { programId: p.id, personId: kid.id, status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: new Date() },
            });
        }

        const a = await withdrawAndReleaseHold(ended.id, kid.id, ended);
        expect(a.released).toBe(true);
        expect(adjust).not.toHaveBeenCalled();

        const b = await withdrawAndReleaseHold(open.id, kid.id, open);
        expect(b.released).toBe(true);
        expect(adjust).toHaveBeenCalledWith(open, 1);
    });
});
