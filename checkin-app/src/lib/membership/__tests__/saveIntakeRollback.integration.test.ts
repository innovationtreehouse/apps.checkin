/**
 * @jest-environment node
 */
/**
 * saveIntake is all or nothing: a save that fails partway leaves no household
 * change and no new person, so resubmitting the form cannot create duplicates.
 */

import prisma from '@/lib/prisma';
import { saveIntake } from '@/lib/membership/intake';

const TAG = 'save-intake-rollback-test';

describe('saveIntake rollback', () => {
    let householdId: number, leadId: number, takenEmailOwnerId: number;

    async function wipe() {
        const people = await prisma.person.findMany({
            where: { OR: [{ household: { name: { contains: TAG } } }, { email: { contains: TAG } }] },
            select: { id: true, householdId: true },
        });
        const personIds = people.map((p) => p.id);
        await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: personIds } }, { affectedEntityId: { in: personIds } }] } });
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
        await prisma.household.deleteMany({ where: { OR: [{ name: { contains: TAG } }, { id: { in: people.map((p) => p.householdId) } }] } });
    }

    beforeAll(async () => {
        await wipe();
        const household = await prisma.household.create({ data: { name: `Family ${TAG}` } });
        const other = await prisma.household.create({ data: { name: `Other ${TAG}` } });
        householdId = household.id;
        leadId = (await prisma.person.create({ data: { name: 'Lead', email: `lead-${TAG}@example.com`, isHouseholdLead: true, isDeclaredAdult: true, householdId } })).id;
        takenEmailOwnerId = (await prisma.person.create({ data: { name: 'Owner', email: `taken-${TAG}@example.com`, isDeclaredAdult: true, householdId: other.id } })).id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    const failingSave = () => saveIntake(leadId, {
        household: { line1: '1 Changed Street' },
        children: [{ name: 'First Child' }, { name: 'Second Child', email: `taken-${TAG}@example.com` }],
    });

    it('a taken child email saves nothing, and resubmitting creates no one', async () => {
        await expect(failingSave()).rejects.toMatchObject({ code: 'email_in_use', fields: ['children'] });
        await expect(failingSave()).rejects.toMatchObject({ code: 'email_in_use', fields: ['children'] });

        expect((await prisma.household.findUniqueOrThrow({ where: { id: householdId } })).line1).toBeNull();
        expect(await prisma.person.count({ where: { householdId } })).toBe(1);
        expect((await prisma.person.findUniqueOrThrow({ where: { id: takenEmailOwnerId } })).householdId).not.toBe(householdId);
    });

    it('a youth second parent saves as a member with a rejection', async () => {
        const { rejections, state } = await saveIntake(leadId, { secondaryParent: { name: 'Young Person', dob: '2020-01-01' } });

        expect(rejections.map((r) => r.code)).toEqual(['youth']);
        expect(state?.prefill.children.map((c) => c.name)).toEqual(['Young Person']);
        expect(state?.prefill.secondaryParent).toBeNull();
    });
});
