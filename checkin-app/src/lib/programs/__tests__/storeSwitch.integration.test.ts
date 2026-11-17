/**
 * @jest-environment node
 */
/**
 * The Board's store switch for program seats (claim-first trial), against a real
 * Postgres and the CHECKIN_ENV=local Shopify stock mock.
 */
import { backendPid, waitersBehind } from '@checkin/pg-test-harness/lockGate';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { runMatchAudit, type MatchAuditResult } from '@/lib/finance/matchAudit';
import { closeProgramStore, openProgramStore } from '@/lib/programs/storeSwitch';
import { changeProgramStock, localMockStock, setProgramInventory, setProgramProductOffSale } from '@/lib/shopify/stock';

jest.mock('@/lib/shopify/stock', () => {
    const actual = jest.requireActual<typeof import('@/lib/shopify/stock')>('@/lib/shopify/stock');
    return { ...actual, setProgramProductOffSale: jest.fn(actual.setProgramProductOffSale) };
});
jest.mock('@/lib/finance/matchAudit', () => ({ runMatchAudit: jest.fn() }));

const TAG = 'Store Switch Test';
const offSale = jest.mocked(setProgramProductOffSale);
const audit = jest.mocked(runMatchAudit);
const cleanAudit: MatchAuditResult = { configured: true, variantCoverage: { lines: 1, withVariant: 1 }, configuredVariants: 1, orders: [], memberships: [], enrollments: [] };

// The lock holder and the re-count take the app pool's connections, so the gate polls on its own.
const observer = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let actorId: number;
let prevEnv: string | undefined;
let logSpy: jest.SpyInstance;

async function mkProgram(name: string, data: { maxParticipants?: number | null; claimant?: boolean; saleEndedAt?: Date } = {}) {
    return prisma.program.create({
        data: {
            appliesToYear: 2026,
            name: `${TAG} ${name}`,
            startAt: new Date('2099-01-01'),
            endAt: new Date('2099-12-31'),
            offSaleAt: data.saleEndedAt ? new Date('2026-01-01') : new Date('2098-01-01'),
            saleEndedAt: data.saleEndedAt ?? null,
            enrollmentStatus: 'OPEN',
            maxParticipants: data.maxParticipants === undefined ? 5 : data.maxParticipants,
            nonOrgMemberPriceCents: 1500,
            shopifyProductId: `prod-${TAG}-${name}`,
            shopifyVariantId: `var-${TAG}-${name}-${Date.now()}`,
            claimantShopifyVariantId: data.claimant === false ? null : `claimant-${name}`,
        },
    });
}

const closedAt = async () => (await prisma.boardSettings.findUniqueOrThrow({ where: { id: 1 } })).programStoreClosedAt;

async function cleanup() {
    const programs = await prisma.program.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await prisma.programParticipant.deleteMany({ where: { programId: { in: programs.map((p) => p.id) } } });
    await prisma.program.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.person.deleteMany({ where: { email: { contains: 'store-switch-test' }, NOT: { id: actorId } } });
    await prisma.household.deleteMany({ where: { name: `${TAG} HH`, householdMembers: { none: {} } } });
    await prisma.boardSettings.update({ where: { id: 1 }, data: { programStoreClosedAt: null } });
}

beforeAll(async () => {
    prevEnv = process.env.CHECKIN_ENV;
    process.env.CHECKIN_ENV = 'local';
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    actorId = (await prisma.person.create({ data: { name: 'Board', email: 'board-store-switch-test@example.com', isBoardMember: true, household: { create: { name: `${TAG} HH` } } } })).id;
});

afterAll(async () => {
    await cleanup();
    await prisma.auditLog.deleteMany({ where: { actorId } });
    await prisma.person.deleteMany({ where: { id: actorId } });
    await prisma.household.deleteMany({ where: { name: `${TAG} HH` } });
    await observer.$disconnect();
    process.env.CHECKIN_ENV = prevEnv;
});

beforeEach(async () => {
    await cleanup();
    jest.clearAllMocks();
    audit.mockResolvedValue(cleanAudit);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => logSpy.mockRestore());

describe('closing the store', () => {
    it('refuses while an unfinished program has no reserved-seat item, and leaves the switch off', async () => {
        await mkProgram('noclaimant', { claimant: false });
        const result = await closeProgramStore(actorId);
        expect(result).toMatchObject({ refused: 'noReservedSeatItem', programs: expect.arrayContaining([`${TAG} noclaimant`]) });
        expect(await closedAt()).toBeNull();
    });

    it('sets the switch with an audit row, zeroes each listed capped item, then hides it', async () => {
        const capped = await mkProgram('capped');
        const uncapped = await mkProgram('uncapped', { maxParticipants: null });
        await setProgramInventory(capped, async () => 5, 'initial-stock');
        const stockAtHide = new Map<string, number | undefined>();
        offSale.mockImplementation(async (p) => {
            if (p.shopifyProductId === capped.shopifyProductId) stockAtHide.set('capped', localMockStock.get(capped.shopifyVariantId!));
            return true;
        });

        const auditsBefore = await prisma.auditLog.count({ where: { actorId, tableName: 'BoardSettings' } });
        const result = await closeProgramStore(actorId);

        expect(result).toMatchObject({ zeroed: expect.arrayContaining([{ programId: capped.id, name: capped.name, ok: true }]), unhidden: [] });
        expect('zeroed' in result && result.zeroed.some((z) => z.programId === uncapped.id)).toBe(false);
        expect(localMockStock.get(capped.shopifyVariantId!)).toBe(0);
        expect(stockAtHide.get('capped')).toBe(0);
        const rows = await prisma.program.findMany({ where: { id: { in: [capped.id, uncapped.id] } } });
        expect(rows.every((r) => r.productHiddenAt !== null)).toBe(true);
        expect(await closedAt()).not.toBeNull();
        expect(await prisma.auditLog.count({ where: { actorId, tableName: 'BoardSettings' } })).toBe(auditsBefore + 1);
        expect(await closeProgramStore(actorId)).toEqual({ refused: 'alreadyClosed' });
    });

    it('while closed, the stock writer blocks a raise and lets a take-back through', async () => {
        const program = await mkProgram('guard');
        await setProgramInventory(program, async () => 1, 'initial-stock');
        await closeProgramStore(actorId);
        localMockStock.set(program.shopifyVariantId!, 1); // a refund restocked a seat

        expect(await changeProgramStock(program, 1, 'hold-release')).toEqual({ recorded: true, landed: true });
        expect(localMockStock.get(program.shopifyVariantId!)).toBe(1);
        expect((await changeProgramStock(program, -1, 'restock-take-back')).landed).toBe(true);
        expect(localMockStock.get(program.shopifyVariantId!)).toBe(0);
        expect((await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).shopifyStockCarry).toBe(0);
    });
});

describe('reopening the store', () => {
    async function closedWith(...names: string[]) {
        const programs = [];
        for (const name of names) programs.push(await mkProgram(name));
        await closeProgramStore(actorId);
        return programs;
    }

    it('refuses while the store is open', async () => {
        expect(await openProgramStore(actorId)).toEqual({ refused: 'notClosed' });
    });

    it('refuses while a hide is unconfirmed, after retrying it', async () => {
        const [program] = await closedWith('stuckhide');
        await prisma.program.update({ where: { id: program.id }, data: { productHiddenAt: null } });
        offSale.mockResolvedValue(false);

        expect(await openProgramStore(actorId)).toMatchObject({ refused: 'hideUnconfirmed', programs: expect.arrayContaining([program.name]) });
        expect(offSale).toHaveBeenCalledWith(expect.objectContaining({ shopifyProductId: program.shopifyProductId }));
        expect(await closedAt()).not.toBeNull();
    });

    it('refuses while the match audit lists an unclaimed paid program order, or cannot run', async () => {
        await closedWith('audit');
        audit.mockResolvedValueOnce({ ...cleanAudit, orders: [{ bucket: 'UNCLAIMED_PAID', orderLegacyId: '1', name: '#1001', customerEmail: null, financialStatus: 'paid', totalCents: 1500, discountCodes: [], expected: [`program: ${TAG} audit`] }] });
        expect(await openProgramStore(actorId)).toEqual({ refused: 'unclaimedOrders', orders: ['#1001'] });

        audit.mockResolvedValueOnce({ ...cleanAudit, configured: false });
        expect(await openProgramStore(actorId)).toEqual({ refused: 'auditUnavailable' });
        expect(await closedAt()).not.toBeNull();
    });

    it('clears the switch and re-counts each open sale as capacity minus seats taken, clearing its hidden mark', async () => {
        const [open, ended] = await closedWith('reopen', 'ended');
        await prisma.program.update({ where: { id: ended.id }, data: { saleEndedAt: new Date('2026-01-02'), offSaleAt: new Date('2026-01-01') } });
        const kid = await prisma.person.create({ data: { name: 'Kid', email: 'kid-store-switch-test@example.com', household: { create: { name: `${TAG} HH` } } } });
        await prisma.programParticipant.create({ data: { programId: open.id, personId: kid.id, status: 'ACTIVE' } });

        const result = await openProgramStore(actorId);

        expect(result).toEqual({ recounted: expect.arrayContaining([{ programId: open.id, name: open.name, ok: true }]) });
        expect('recounted' in result && result.recounted.some((r) => r.programId === ended.id)).toBe(false);
        expect(await closedAt()).toBeNull();
        expect(localMockStock.get(open.shopifyVariantId!)).toBe(4);
        expect((await prisma.program.findUniqueOrThrow({ where: { id: open.id } })).productHiddenAt).toBeNull();
        expect((await prisma.program.findUniqueOrThrow({ where: { id: ended.id } })).productHiddenAt).not.toBeNull();
    });

    it('the re-count reads stock only once it holds the Program row lock, so a write landing before it is counted', async () => {
        const program = await mkProgram('recount-lock');
        await setProgramInventory(program, async () => 3, 'initial-stock');

        let release!: () => void;
        const released = new Promise<void>((r) => (release = r));
        let locked!: (pid: number) => void;
        const held = new Promise<number>((r) => (locked = r));
        const holder = prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Program" WHERE id = ${program.id} FOR UPDATE`;
            locked(await backendPid(tx));
            await released;
        }, { timeout: 15_000 });
        const holderPid = await held;

        const recount = setProgramInventory(program, async () => 3, 'store-reopened');
        try {
            await waitersBehind(observer, holderPid);
            localMockStock.set(program.shopifyVariantId!, 1); // the switch's zero, or store sales, land first
        } finally {
            release();
            await holder;
        }

        expect(await recount).toBe(true);
        expect(localMockStock.get(program.shopifyVariantId!)).toBe(3);
    });
});
