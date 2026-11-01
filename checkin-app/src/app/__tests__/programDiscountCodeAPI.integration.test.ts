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
import * as shopify from '@/lib/shopify/discounts';
import { verifyCheckout } from '@/lib/programs/checkoutSignature';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

// Wrap only mintMemberDiscountCode so its call args are observable while every
// other export (including its own callees like config) stays real — SWC compiles
// this module's named exports as non-configurable getters, so jest.spyOn can't
// redefine the property directly; jest.fn(actual) preserves call-through.
jest.mock('@/lib/shopify/discounts', () => {
    const actual = jest.requireActual('@/lib/shopify/discounts');
    return { ...actual, mintMemberDiscountCode: jest.fn(actual.mintMemberDiscountCode) };
});

const TAG = 'discount-code-duration-test';
process.env.NEXTAUTH_SECRET ||= 'integration-test-nextauth-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

async function post(programId: number, participantIds: number[]) {
    const req = new Request(`http://localhost:4000/api/programs/${programId}/discount-code`, {
        method: 'POST',
        body: JSON.stringify({ participantIds }),
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
    let unsettledHouseholdId: number;
    let settledPersonId: number;
    let settledHouseholdId: number;
    let nonMemberPersonId: number;
    let youthPersonId: number;
    let coveredProgramId: number;
    let uncoveredProgramId: number;
    let statedEarlierProgramId: number;

    async function wipe() {
        const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const householdIds = people.map((p) => p.householdId);
        if (householdIds.length) {
            const memberships = await prisma.orgMembership.findMany({ where: { householdId: { in: householdIds } }, select: { id: true } });
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId: { in: memberships.map((m) => m.id) } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
        }
        await prisma.programParticipant.deleteMany({ where: { program: { name: { contains: TAG } } } });
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
                email: `unsettled-${TAG}@example.com`, name: 'Unsettled Member', isHouseholdLead: true,
                household: { create: { name: `Unsettled HH ${TAG}`, orgMembership: { create: { status: 'ACTIVE' } } } },
            },
            select: { id: true, householdId: true },
        });
        unsettledPersonId = unsettled.id;
        unsettledHouseholdId = unsettled.householdId;

        // Settled member: ACTIVE membership + a terminal ACTIVE process stamped
        // inside the current renewal window — valid one boundary further.
        const settled = await prisma.person.create({
            data: {
                email: `settled-${TAG}@example.com`, name: 'Settled Member', isHouseholdLead: true,
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

        // A youth in the settled household — not its lead.
        const youth = await prisma.person.create({
            data: {
                email: `youth-${TAG}@example.com`, name: 'Youth Member', householdId: settledHouseholdId,
                dateOfBirth: new Date(Date.now() - 12 * 365 * DAY_MS),
            },
            select: { id: true },
        });
        youthPersonId = youth.id;

        const nonMember = await prisma.person.create({
            data: { email: `nonmember-${TAG}@example.com`, name: 'Non Member', isHouseholdLead: true, household: { create: { name: `Non Member HH ${TAG}` } } },
            select: { id: true },
        });
        nonMemberPersonId = nonMember.id;

        // Single-pool program (shopifyVariantId set) that the discount-code route
        // handles; two price tiers so it computes a non-zero discount amount.
        const covered = await prisma.program.create({
            data: {
                appliesToYear: boundary.getUTCFullYear() - 1,
                startAt: new Date('2026-01-01'),
                name: `Covered Prog ${TAG}`, phase: 'UPCOMING', endAt: coveredEndAt,
                shopifyVariantId: 'dev-mock-variant-discount-code-covered',
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000,
            },
        });
        coveredProgramId = covered.id;

        const uncovered = await prisma.program.create({
            data: {
                appliesToYear: boundary.getUTCFullYear(),
                startAt: new Date('2026-01-01'),
                name: `Uncovered Prog ${TAG}`, phase: 'UPCOMING', endAt: uncoveredEndAt,
                shopifyVariantId: 'dev-mock-variant-discount-code-uncovered',
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000,
            },
        });
        uncoveredProgramId = uncovered.id;

        // Same past-boundary end date, but stated as the membership year the
        // upcoming boundary closes.
        const statedEarlier = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                name: `Stated Earlier Prog ${TAG}`, phase: 'UPCOMING', endAt: uncoveredEndAt,
                appliesToYear: boundary.getUTCFullYear() - 1,
                shopifyVariantId: 'dev-mock-variant-discount-code-stated-earlier',
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000,
            },
        });
        statedEarlierProgramId = statedEarlier.id;

        // Every checkout below pays for real unpaid claims.
        await prisma.programParticipant.createMany({
            data: [unsettledPersonId, settledPersonId, nonMemberPersonId].flatMap((personId) => [
                { programId: coveredProgramId, personId, status: 'PENDING' as const },
                { programId: uncoveredProgramId, personId, status: 'PENDING' as const },
                { programId: statedEarlierProgramId, personId, status: 'PENDING' as const },
            ]),
        });
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
        const res = await post(coveredProgramId, [unsettledPersonId]);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toMatch(new RegExp(`^PRG${coveredProgramId}-H${unsettledHouseholdId}-`));
        expect(data.reason).toBeUndefined();
        expect(verifyCheckout(coveredProgramId, [unsettledPersonId], unsettledHouseholdId, data.signature)).toBe(true);
        // 5000 (non-member) - 4000 (member) = 1000: the amount actually
        // reaches the minting call, not just the response shape.
        expect(mintSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: coveredProgramId, shopifyVariantId: 'dev-mock-variant-discount-code-covered' }),
            unsettledHouseholdId,
            1000,
        );
    });

    it('returns { code: null, reason } when the program ends after an unsettled member\'s boundary', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: unsettledPersonId } });
        const res = await post(uncoveredProgramId, [unsettledPersonId]);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toBeNull();
        expect(data.reason).toBe('membership_ends_before_program');
        expect(mintSpy).not.toHaveBeenCalled();
    });

    it('mints a code for the same past-boundary program once the household is settled for the coming year', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: settledPersonId } });
        const res = await post(uncoveredProgramId, [settledPersonId]);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toMatch(new RegExp(`^PRG${uncoveredProgramId}-H${settledHouseholdId}-`));
        expect(data.reason).toBeUndefined();
        expect(mintSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: uncoveredProgramId, shopifyVariantId: 'dev-mock-variant-discount-code-uncovered' }),
            settledHouseholdId,
            1000,
        );
    });

    it('mints a code for a past-boundary program stated as the year the unsettled member is covered for', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: unsettledPersonId } });
        const res = await post(statedEarlierProgramId, [unsettledPersonId]);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toMatch(new RegExp(`^PRG${statedEarlierProgramId}-H${unsettledHouseholdId}-`));
        expect(mintSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: statedEarlierProgramId, shopifyVariantId: 'dev-mock-variant-discount-code-stated-earlier' }),
            unsettledHouseholdId,
            1000,
        );
    });

    it('a non-member still gets { code: null } with no reason', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: nonMemberPersonId } });
        const res = await post(coveredProgramId, [nonMemberPersonId]);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.code).toBeNull();
        expect(data.reason).toBeUndefined();
        expect(mintSpy).not.toHaveBeenCalled();
    });

    it('refuses a checkout that names someone from another household', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: settledPersonId } });
        const res = await post(coveredProgramId, [settledPersonId, nonMemberPersonId]);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/must be from your household/);
        expect(mintSpy).not.toHaveBeenCalled();
    });

    it('refuses a caller who is not a lead of their household (a youth)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: youthPersonId } });
        const res = await post(coveredProgramId, [settledPersonId]);
        expect(res.status).toBe(403);
        expect((await res.json()).error).toMatch(/household lead/);
        expect(mintSpy).not.toHaveBeenCalled();
    });

    it('refuses a checkout without participantIds', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: settledPersonId } });
        const res = await post(coveredProgramId, []);
        expect(res.status).toBe(400);
        expect(mintSpy).not.toHaveBeenCalled();
    });

    it('mints nothing for a member with no unpaid claim in the program', async () => {
        await prisma.programParticipant.update({
            where: { programId_personId: { programId: coveredProgramId, personId: settledPersonId } },
            data: { status: 'ACTIVE' },
        });
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: settledPersonId } });
        const res = await post(coveredProgramId, [settledPersonId]);
        expect(res.status).toBe(200);
        expect((await res.json()).code).toBeNull();
        expect(mintSpy).not.toHaveBeenCalled();
    });
});
