/**
 * @jest-environment node
 */
/**
 * householdOf against real households: expense sign-off and receipt build their conflict
 * sets from it, so what matters is who comes back, not how the query is written.
 */
import prisma from '@/lib/prisma';
import { householdIds, householdOf, householdsOf } from '../ports';

const TAG = 'ports-household-of';

describe('householdOf', () => {
    let adaId: number, benId: number, cyId: number, dotId: number;

    async function wipe() {
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
    }

    const person = async (name: string, householdId: number) =>
        (await prisma.person.create({ data: { name, email: `${name}-${TAG}@example.com`, householdId } })).id;

    beforeAll(async () => {
        await wipe();
        const first = await prisma.household.create({ data: { name: `First ${TAG}` } });
        const second = await prisma.household.create({ data: { name: `Second ${TAG}` } });
        adaId = await person('ada', first.id);
        benId = await person('ben', first.id);
        cyId = await person('cy', second.id);
        dotId = await person('dot', second.id);
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

    it('returns only the named person\'s household', async () => {
        expect(sorted(await householdOf([adaId]))).toEqual(sorted([adaId, benId]));
        expect(sorted(await householdOf([cyId]))).toEqual(sorted([cyId, dotId]));
    });

    it('returns every household when people from both are named', async () => {
        expect(sorted(await householdOf([benId, dotId]))).toEqual(sorted([adaId, benId, cyId, dotId]));
    });

    it('returns nobody for nobody', async () => {
        await expect(householdOf([])).resolves.toEqual([]);
    });

    it('householdsOf maps each person to what householdOf returns for them alone', async () => {
        const households = await householdsOf([adaId, benId, dotId, -1]);
        for (const id of [adaId, benId, dotId]) expect(sorted(households.get(id) ?? [])).toEqual(sorted(await householdOf([id])));
        expect(households.has(-1)).toBe(false);
        await expect(householdsOf([])).resolves.toEqual(new Map());
    });

    it('householdIds returns every member of one household', async () => {
        expect(sorted(await householdIds(benId))).toEqual(sorted([adaId, benId]));
        await expect(householdIds(-1)).resolves.toEqual([]);
    });
});
