/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/programs/[id]/discount-code — the
 * membership-DURATION guard: member pricing (and this discount code) applies
 * only when the buyer's membership covers the program's whole run, not just
 * "is a member today". CHECKIN_ENV=local arms the Shopify mock
 * (config.shopifyMockActive) so mintMemberDiscountCode short-circuits without
 * real Shopify credentials, mirroring programVariantRoundtripShopify.
 */
import { POST } from '@/app/api/programs/[id]/discount-code/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';
import * as shopify from '@/lib/shopify';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

// Wrap only mintMemberDiscountCode so its call args are observable while every
// other export (including its own callees like config) stays real — SWC compiles
// this module's named exports as non-configurable getters, so jest.spyOn can't
// redefine the property directly; jest.fn(actual) preserves call-through.
jest.mock('@/lib/shopify', () => {
    const actual = jest.requireActual('@/lib/shopify');
    return { ...actual, mintMemberDiscountCode: jest.fn(actual.mintMemberDiscountCode) };
});

const TAG = 'discount-code-duration-test';
const DAY_MS = 24 * 60 * 60 * 1000;

async function post(programId: number) {
    const req = new Request(`http://localhost:4000/api/programs/${programId}/discount-code`, {
        method: 'POST',
        // CHECKIN_ENV=local also arms the keyless-kiosk fallback in
        // authenticateRequest, which hijacks any cookie-less request as kiosk
        // (403) before the session gate runs — see programsIdAPI's Shopify block.
        headers: { cookie: 'session=test' },
    });
    return POST(req as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: String(programId) }) });
}

describe('POST /api/programs/[id]/discount-code — membership duration', () => {
    let prevCheckinEnv: string | undefined;
    let restoreBoardSettings: () => Promise<void> = async () => {};

    // now + 45 days sits inside the 2-month renewal lead window, so the
    // "settled" probe (ACTIVE process stamped inside the window) is reachable.
    const boundary = new Date(Date.now() + 45 * DAY_MS);
    const coveredEndAt = new Date(boundary.getTime() - 5 * DAY_MS); // before the boundary
    const uncoveredEndAt = new Date(boundary.getTime() + 10 * DAY_MS); // after the boundary, within +1y

    let unsettledPersonId: number;
    let settledPersonId: number;
    let settledHouseholdId: number;
    let nonMemberPersonId: number;
    let coveredProgramId: number;
    let uncoveredProgramId: number;

    async function wipe() {
        const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const householdIds = people.map((p) => p.householdId);
        if (householdIds.length) {
            const memberships = await prisma.orgMembership.findMany({ where: { householdId: { in: householdIds } }, select: { id: true } });
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId: { in: memberships.map((m) => m.id) } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
    }

    beforeAll(async () => {
        prevCheckinEnv = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'local';

        restoreBoardSettings = await snapshotBoardSettings();
        await wipe();

        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipYearBoundary: boundary, bgRecheckMonths: 12 },
            update: { orgMembershipYearBoundary: boundary },
        });

        // Unsettled member: ACTIVE membership, no renewal process — valid only
        // through the upcoming boundary.
        const unsettled = await prisma.person.create({
            data: {
                email: `unsettled-${TAG}@example.com`, name: 'Unsettled Member',
                household: { create: { name: `Unsettled HH ${TAG}`, orgMembership: { create: { status: 'ACTIVE' } } } },
            },
            select: { id: true, householdId: true },
        });
        unsettledPersonId = unsettled.id;

        // Settled member: ACTIVE membership + a terminal ACTIVE process stamped
        // inside the current renewal window — valid one boundary further.
        const settled = await prisma.person.create({
            data: {
                email: `settled-${TAG}@example.com`, name: 'Settled Member',
                household: { create: { name: `Settled HH ${TAG}`, orgMembership: { create: { status: 'ACTIVE' } } } },
            },
            select: { id: true, householdId: true },
        });
        settledPersonId = settled.id;
        settledHouseholdId = settled.householdId;
        const settledMembership = await prisma.orgMembership.findUniqueOrThrow({ where: { householdId: settledHouseholdId } });
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: settledMembership.id, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: new Date() },
        });

        const nonMember = await prisma.person.create({
            data: { email: `nonmember-${TAG}@example.com`, name: 'Non Member', household: { create: { name: `Non Member HH ${TAG}` } } },
            select: { id: true },
        });
        nonMemberPersonId = nonMember.id;

        // Single-pool program (shopifyVariantId set) that the discount-code route
        // handles; two price tiers so it computes a non-zero discount amount.
        const covered = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                name: `Covered Prog ${TAG}`, phase: 'UPCOMING', endAt: coveredEndAt,
                shopifyVariantId: 'dev-mock-variant-discount-code-covered',
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000,
            },
        });
        coveredProgramId = covered.id;

        const uncovered = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                name: `Uncovered Prog ${TAG}`, phase: 'UPCOMING', endAt: uncoveredEndAt,
                shopifyVariantId: 'dev-mock-variant-discount-code-uncovered',
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000,
            },
        });
        uncoveredProgramId = uncovered.id;
    });

    afterAll(async () => {
        await wipe();
        await restoreBoardSettings();
        if (prevCheckinEnv === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = prevCheckinEnv;
        await prisma.$disconnect();
    });

    const mintSpy = shopify.mintMemberDiscountCode as jest.Mock;

    afterEach(() => {
        mintSpy.mockClear();
    });

    it('mints a code when the member\'s validity covers the program\'s endAt', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: unsettledPersonId } });
        const res = await post(coveredProgramId);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toEqual(expect.stringContaining(`PRG${coveredProgramId}-`));
        expect(data.reason).toBeUndefined();
        // 5000 (non-member) - 4000 (member) = 1000: the amount actually
        // reaches the minting call, not just the response shape.
        expect(mintSpy).toHaveBeenCalledWith(coveredProgramId, 'dev-mock-variant-discount-code-covered', 1000);
    });

    it('returns { code: null, reason } when the program ends after an unsettled member\'s boundary', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: unsettledPersonId } });
        const res = await post(uncoveredProgramId);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toBeNull();
        expect(data.reason).toBe('membership_ends_before_program');
        expect(mintSpy).not.toHaveBeenCalled();
    });

    it('mints a code for the same past-boundary program once the household is settled for the coming year', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: settledPersonId } });
        const res = await post(uncoveredProgramId);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toEqual(expect.stringContaining(`PRG${uncoveredProgramId}-`));
        expect(data.reason).toBeUndefined();
        expect(mintSpy).toHaveBeenCalledWith(uncoveredProgramId, 'dev-mock-variant-discount-code-uncovered', 1000);
    });

    it('a non-member still gets { code: null } with no reason (unchanged behavior)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: nonMemberPersonId } });
        const res = await post(coveredProgramId);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toBeNull();
        expect(data.reason).toBeUndefined();
        expect(mintSpy).not.toHaveBeenCalled();
    });
});
