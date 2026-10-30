/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { isActiveOrgMember } from '@/lib/orgMembership';
import { isKnownAdult } from '@/lib/programAge';
import { addNonMemberAdult } from '@/lib/person/ownHousehold';

const TAG = 'own-household-test';

async function cleanup() {
    const people = await prisma.person.findMany({ where: { name: { contains: TAG } }, select: { id: true, householdId: true } });
    await prisma.person.deleteMany({ where: { id: { in: people.map((p) => p.id) } } });
    await prisma.household.deleteMany({ where: { id: { in: [...new Set(people.map((p) => p.householdId))] } } });
}

beforeAll(cleanup);
afterAll(cleanup);

describe('addNonMemberAdult', () => {
    it('adds a declared adult with no email, leading a household of their own with no membership', async () => {
        const added = await addNonMemberAdult(prisma, `  Dana Field ${TAG} `);
        expect(added.name).toBe(`Dana Field ${TAG}`);

        const person = await prisma.person.findUniqueOrThrow({
            where: { id: added.id },
            select: { email: true, dateOfBirth: true, isDeclaredAdult: true, isHouseholdLead: true, householdId: true },
        });
        expect(person).toMatchObject({ email: null, dateOfBirth: null, isDeclaredAdult: true, isHouseholdLead: true });
        expect(isKnownAdult(person)).toBe(true);
        expect(await prisma.person.count({ where: { householdId: person.householdId } })).toBe(1);
        expect(await isActiveOrgMember(added.id)).toBe(false);
    });

    it('adds a second person of the same name as a separate person', async () => {
        const first = await addNonMemberAdult(prisma, `Sam Twin ${TAG}`);
        const second = await addNonMemberAdult(prisma, `Sam Twin ${TAG}`);
        expect(second.id).not.toBe(first.id);
    });
});
