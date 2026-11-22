/**
 * @jest-environment node
 */
/**
 * Integration tests for the person-scoped PERSON_BG_NEEDED / DOB_MISSING buckets
 * of GET /api/membership-audit/compliance (warn-only). Asserts a ≥18
 * non-fresh program participant / volunteer / lead and position holder surfaces,
 * a household lead holding no position does not, under-18 and fresh people are
 * omitted, a program volunteer with no membership still appears in the person-level
 * list, and a missing-DOB person lands in the data-hygiene bucket.
 */

import { GET } from '@/app/api/membership-audit/compliance/route';
import { liveMembershipYear, nextBoundary } from '@/lib/membership/renewal';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'person-bg-test';
const RECHECK_MONTHS = 12;
const BOUNDARY_SEED = new Date('2000-06-01'); // only month/day matter to nextBoundary()
// Age is judged as-of the boundary the route computes from the real clock, so the
// minor's DOB is derived from that same boundary — a literal year would age past
// 18 and flip the verdict to NEEDED. 10 as of the boundary keeps clear of the
// inclusive ≥18 edge.
const BOUNDARY = nextBoundary(BOUNDARY_SEED, new Date());
const MINOR_DOB = new Date(Date.UTC(BOUNDARY.getUTCFullYear() - 10, BOUNDARY.getUTCMonth(), BOUNDARY.getUTCDate()));

function get() {
    return GET(new Request('http://localhost:4000/api/membership-audit/compliance', {
        method: 'GET',
    }) as unknown as import('next/server').NextRequest);
}

/** A person in their own household (no OrgMembership = not a member household). */
async function makePerson(slug: string, data: {
    dateOfBirth?: Date | null;
    isDeclaredAdult?: boolean;
    lastBackgroundCheck?: Date | null;
}) {
    const household = await prisma.household.create({ data: { name: `${TAG} ${slug}` } });
    return prisma.person.create({
        data: {
            email: `${slug}-${TAG}@example.com`,
            name: `${slug} person`,
            householdId: household.id,
            dateOfBirth: data.dateOfBirth ?? null,
            isDeclaredAdult: data.isDeclaredAdult ?? false,
            lastBackgroundCheck: data.lastBackgroundCheck ?? null,
        },
    });
}

describe('GET /api/membership-audit/compliance — person BG buckets', () => {
    let boardId: number;
    let programId: number;
    let participantId: number;
    let volunteerId: number;
    let leadId: number;
    let minorId: number;
    let freshId: number;
    let missingDobId: number;
    let plainLeadId: number;
    let roleLeadId: number;
    let ownerId: number;
    let treasurerId: number;
    let keyholderId: number;
    let savedSettings: { bgRecheckMonths: number; orgMembershipYearBoundary: Date | null } | null = null;

    const cleanup = async () => {
        const progs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const progIds = progs.map(p => p.id);
        await prisma.programParticipant.deleteMany({ where: { programId: { in: progIds } } });
        await prisma.programVolunteer.deleteMany({ where: { programId: { in: progIds } } });
        // Drop the leadMentor FK before deleting the lead person.
        await prisma.program.deleteMany({ where: { id: { in: progIds } } });
        await prisma.budgetOwnerTreasurer.deleteMany({ where: { budgetOwner: { name: { contains: TAG } } } });
        await prisma.budgetOwner.deleteMany({ where: { name: { contains: TAG } } });
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const hhIds = hhs.map(h => h.id);
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: hhIds } } });
        await prisma.person.deleteMany({ where: { OR: [{ email: { contains: TAG } }, { householdId: { in: hhIds } }] } });
        await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
    };

    beforeAll(async () => {
        await cleanup();

        const prev = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        savedSettings = prev ? { bgRecheckMonths: prev.bgRecheckMonths, orgMembershipYearBoundary: prev.orgMembershipYearBoundary } : null;
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, bgRecheckMonths: RECHECK_MONTHS, orgMembershipYearBoundary: BOUNDARY_SEED },
            update: { bgRecheckMonths: RECHECK_MONTHS, orgMembershipYearBoundary: BOUNDARY_SEED },
        });

        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board Actor', isBoardMember: true, household: { create: { name: `${TAG} board` } } },
        });
        boardId = board.id;

        // Adult, no check → NEEDED. Enrolled as a participant.
        participantId = (await makePerson('participant', { dateOfBirth: new Date('1990-01-01') })).id;
        // Adult, no check, in a non-member household → NEEDED, must appear in the person list.
        volunteerId = (await makePerson('volunteer', { dateOfBirth: new Date('1988-01-01') })).id;
        // Adult, no check → NEEDED. Program lead.
        leadId = (await makePerson('lead', { dateOfBirth: new Date('1985-01-01') })).id;
        // Under 18 → excluded even though attached as a volunteer.
        minorId = (await makePerson('minor', { dateOfBirth: MINOR_DOB })).id;
        // Adult with a current check → FRESH, excluded.
        freshId = (await makePerson('fresh', { dateOfBirth: new Date('1980-01-01'), lastBackgroundCheck: new Date() })).id;
        // No DOB, not declared adult → DOB_MISSING, not NEEDED.
        missingDobId = (await makePerson('nodob', { dateOfBirth: null })).id;

        const program = await prisma.program.create({ data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `${TAG} program`, leadMentorId: leadId } });
        programId = program.id;
        await prisma.programParticipant.create({ data: { programId, personId: participantId } });
        await prisma.programParticipant.create({ data: { programId, personId: freshId } });
        await prisma.programParticipant.create({ data: { programId, personId: missingDobId } });
        await prisma.programVolunteer.create({ data: { programId, personId: volunteerId } });
        await prisma.programVolunteer.create({ data: { programId, personId: minorId } });

        // Leads of ACTIVE member households, no check, attached to no program.
        const lead = async (slug: string) => {
            const p = await makePerson(slug, { dateOfBirth: new Date('1982-01-01') });
            await prisma.person.update({ where: { id: p.id }, data: { isHouseholdLead: true } });
            await prisma.orgMembership.create({ data: { householdId: p.householdId, status: 'ACTIVE' } });
            return p.id;
        };
        plainLeadId = await lead('plainlead');
        roleLeadId = await lead('rolelead');
        await prisma.personRole.create({ data: { personId: roleLeadId, role: 'KEYHOLDER' } });
        ownerId = (await makePerson('owner', { dateOfBirth: new Date('1979-01-01') })).id;
        treasurerId = (await makePerson('treasurer', { dateOfBirth: new Date('1978-01-01') })).id;
        const bucket = await prisma.budgetOwner.create({ data: { name: `${TAG} bucket`, ownerId } });
        await prisma.budgetOwnerTreasurer.create({ data: { budgetOwnerId: bucket.id, personId: treasurerId } });

        // Checked on September 1 before the live year opened (2025-09-01 for the
        // 2026-2027 year): valid at that year's start, stale at the next boundary.
        const liveYear = liveMembershipYear(BOUNDARY_SEED, new Date())!;
        keyholderId = (await makePerson('keyholder', { dateOfBirth: new Date('1975-01-01'), lastBackgroundCheck: new Date(Date.UTC(liveYear - 1, 8, 1)) })).id;
        await prisma.personRole.create({ data: { personId: keyholderId, role: 'KEYHOLDER' } });
    });

    afterAll(async () => {
        await cleanup();
        // Unconditional: a row this suite created must go, or its boundary leaks into
        // suites that share this DB and expect none.
        if (savedSettings) {
            await prisma.boardSettings.update({ where: { id: 1 }, data: savedSettings });
        } else {
            await prisma.boardSettings.delete({ where: { id: 1 } }).catch(() => {});
        }
    });

    it('flags ≥18 non-fresh participant/volunteer/lead and omits minor + fresh', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await get();
        expect(res.status).toBe(200);
        const { peopleNeedingBgCheck, peopleMissingDob } = await res.json();

        const needIds = new Set(peopleNeedingBgCheck.map((p: { personId: number }) => p.personId));
        expect(needIds.has(participantId)).toBe(true);
        expect(needIds.has(volunteerId)).toBe(true);
        expect(needIds.has(leadId)).toBe(true);
        expect(needIds.has(minorId)).toBe(false);
        expect(needIds.has(freshId)).toBe(false);
        expect(needIds.has(missingDobId)).toBe(false);

        // Every needed row carries the tag + program context; the volunteer has no membership.
        for (const p of peopleNeedingBgCheck) {
            if (needIds.has(p.personId)) expect(p.reason).toBe('PERSON_BG_NEEDED');
        }
        const vol = peopleNeedingBgCheck.find((p: { personId: number }) => p.personId === volunteerId);
        expect(vol.programId).toBe(programId);

        // Missing-DOB person is data-hygiene, not bg-needed.
        const dobIds = new Set(peopleMissingDob.map((p: { personId: number }) => p.personId));
        expect(dobIds.has(missingDobId)).toBe(true);
        expect(needIds.has(missingDobId)).toBe(false);
        const miss = peopleMissingDob.find((p: { personId: number }) => p.personId === missingDobId);
        expect(miss.reason).toBe('DOB_MISSING');
    });

    it('lists position holders, and no household lead for being a lead', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const { peopleNeedingBgCheck } = await (await get()).json();
        const needIds = new Set(peopleNeedingBgCheck.map((p: { personId: number }) => p.personId));
        expect(needIds.has(plainLeadId)).toBe(false);
        expect(needIds.has(roleLeadId)).toBe(true);
        expect(needIds.has(ownerId)).toBe(true);
        expect(needIds.has(treasurerId)).toBe(true);
    });

    it('judges a role holder at the start of the year they serve, agreeing with the positions list', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const { peopleNeedingBgCheck, positionHolders } = await (await get()).json();
        expect(peopleNeedingBgCheck.some((p: { personId: number }) => p.personId === keyholderId)).toBe(false);
        expect(positionHolders.find((p: { personId: number }) => p.personId === keyholderId)?.standing).toBe('CURRENT');
    });
});
