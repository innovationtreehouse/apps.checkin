/**
 * @jest-environment node
 */
/**
 * LIVE_KEYHOLDER (a Prisma where) and isLiveKeyholder (a pure helper) encode the
 * same rule. This seeds one person per case against real Postgres and checks the
 * helper picks exactly the set the where clause returns.
 */
import prisma from '@/lib/prisma';
import { OrgMembershipStatus } from '@/generated/prisma/client';
import { LIVE_KEYHOLDER, isLiveKeyholder } from '@/lib/visit/filters';

const TAG = 'live-keyholder-agreement';
const STATUSES = Object.values(OrgMembershipStatus);

describe('LIVE_KEYHOLDER and isLiveKeyholder agree (integration)', () => {
    const householdIds: number[] = [];
    const personIds: number[] = [];

    async function seed(isKeyholder: boolean, status: OrgMembershipStatus | null) {
        const key = `${isKeyholder ? 'kh' : 'nokh'}-${status ?? 'nomembership'}`;
        const person = await prisma.person.create({
            data: {
                name: key,
                email: `${key}-${TAG}@example.com`,
                isKeyholder,
                household: { create: { name: `${key} HH ${TAG}` } },
            },
        });
        if (status) await prisma.orgMembership.create({ data: { householdId: person.householdId, status } });
        householdIds.push(person.householdId);
        personIds.push(person.id);
    }

    beforeAll(async () => {
        for (const isKeyholder of [true, false]) {
            await seed(isKeyholder, null);
            for (const status of STATUSES) await seed(isKeyholder, status);
        }
    });

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it('selects the same people for every flag × household status, including no orgMembership', async () => {
        const viaWhere = await prisma.person.findMany({
            where: { id: { in: personIds }, ...LIVE_KEYHOLDER },
            select: { id: true },
        });
        const all = await prisma.person.findMany({
            where: { id: { in: personIds } },
            select: { id: true, isKeyholder: true, household: { select: { orgMembership: { select: { status: true } } } } },
        });

        expect(all).toHaveLength(2 * (STATUSES.length + 1));
        expect(all.filter(isLiveKeyholder).map((p) => p.id).sort()).toEqual(viaWhere.map((p) => p.id).sort());
    });

    // Person.householdId is required, so no row has a null household; the helper
    // must treat one like a household with no orgMembership.
    it('treats a missing household like a household with no orgMembership', () => {
        for (const isKeyholder of [true, false]) {
            const noMembership = isLiveKeyholder({ isKeyholder, household: { orgMembership: null } });
            expect(isLiveKeyholder({ isKeyholder, household: null })).toBe(noMembership);
            expect(isLiveKeyholder({ isKeyholder })).toBe(noMembership);
        }
    });
});
