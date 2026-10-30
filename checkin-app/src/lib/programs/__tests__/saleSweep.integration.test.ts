/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { runSaleSweep } from '@/lib/programs/saleSweep';
import { deleteAndReleaseHold } from '@/lib/program/capacity';
import { reportShopifyFailure } from '@/lib/shopify/client';
import { setProgramProductOffSale, adjustProgramInventory } from '@/lib/shopify/stock';
import { emailBoardMembers } from '@/lib/emailRecipients';

jest.mock('@/lib/shopify/stock', () => ({
    setProgramProductOffSale: jest.fn().mockResolvedValue(true),
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
    changeProgramStockWith: jest.fn((...a: unknown[]) => jest.requireActual('@/test-helpers/stockWith').forwardStockWith(...a)),
}));
jest.mock('@/lib/shopify/client', () => ({
    reportShopifyFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'Sale Sweep Test';
const HH = 'Sale Sweep Test HH';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-12T09:15:00Z');
const day = (s: string) => new Date(`${s}T00:00:00Z`);

const offSale = jest.mocked(setProgramProductOffSale);
const adjust = jest.mocked(adjustProgramInventory);
const report = jest.mocked(reportShopifyFailure);
const emailBoard = jest.mocked(emailBoardMembers);

async function mkProgram(name: string, data: Partial<{ startAt: Date; offSaleAt: Date | null; phase: 'UPCOMING' | 'FINISHED'; saleEndedAt: Date; claimantShopifyVariantId: string }>) {
    return prisma.program.create({
        data: {
            appliesToYear: 2026,
            name: `${TAG} ${name}`,
            startAt: data.startAt ?? day('2026-11-01'),
            endAt: day('2026-12-31'),
            offSaleAt: data.offSaleAt ?? null,
            phase: data.phase ?? 'UPCOMING',
            enrollmentStatus: 'OPEN',
            shopifyProductId: `prod-${name}`,
            shopifyVariantId: `var-${name}`,
            saleEndedAt: data.saleEndedAt ?? null,
            claimantShopifyVariantId: data.claimantShopifyVariantId ?? null,
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

    it('ends due sales once and closes enrollment; leaves future and finished programs alone', async () => {
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
        const later = new Date(NOW.getTime() + DAY_MS);
        await runSaleSweep(later);
        expect((await prisma.program.findUniqueOrThrow({ where: { id: due.id } })).saleEndedAt).toEqual(NOW);
    });

    // The DB may hold other (seeded) programs whose sale is also due; look only at ours.
    const oursHidden = () => offSale.mock.calls.map(([p]) => p.shopifyProductId).filter((id) => id?.startsWith('prod-'));
    const oursReported = () => report.mock.calls.map(([, , ctx]) => ctx.shopifyProductId).filter((id) => typeof id === 'string' && id.startsWith('prod-'));

    it('hides the public product of an ended sale that has a reserved-seat product, once', async () => {
        await mkProgram('hide', { startAt: day('2026-10-12'), claimantShopifyVariantId: 'claimant-hide' });
        await runSaleSweep(NOW);
        expect(oursHidden()).toEqual(['prod-hide']);
        expect(oursReported()).toEqual([]);

        offSale.mockClear();
        await runSaleSweep(new Date(NOW.getTime() + DAY_MS));
        expect(oursHidden()).toEqual([]);
    });

    it('retries a failed hide on the next run and stamps productHiddenAt only on success', async () => {
        const program = await mkProgram('retryhide', { startAt: day('2026-10-12'), claimantShopifyVariantId: 'claimant-retry' });
        offSale.mockImplementation(async (p) => p.shopifyProductId !== 'prod-retryhide');
        await runSaleSweep(NOW);
        expect(oursHidden()).toEqual(['prod-retryhide']);
        expect((await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).productHiddenAt).toBeNull();

        offSale.mockReset();
        offSale.mockResolvedValue(true);
        const later = new Date(NOW.getTime() + DAY_MS);
        await runSaleSweep(later);
        expect(oursHidden()).toEqual(['prod-retryhide']);
        expect((await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).productHiddenAt).toEqual(later);
    });

    it('keeps the public product on sale and alerts the admins when there is no reserved-seat product', async () => {
        await mkProgram('noclaimant', { startAt: day('2026-10-12') });
        await runSaleSweep(NOW);
        expect(oursHidden()).toEqual([]);
        expect(oursReported()).toEqual(['prod-noclaimant']);
        const html = report.mock.calls.find(([, , ctx]) => ctx.shopifyProductId === 'prod-noclaimant')![3];
        expect(html).toMatch(/reserved-seat product/);
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

        const a = await deleteAndReleaseHold(ended.id, kid.id, ended);
        expect(a.released).toBe(true);
        expect(adjust).not.toHaveBeenCalled();

        const b = await deleteAndReleaseHold(open.id, kid.id, open);
        expect(b.released).toBe(true);
        expect(adjust).toHaveBeenCalledWith({ id: open.id, shopifyVariantId: open.shopifyVariantId }, 1, 'hold-release', {});
    });
});
