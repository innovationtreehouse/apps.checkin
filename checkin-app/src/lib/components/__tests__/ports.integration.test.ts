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
    let adaId: number, benId: number, mergedId: number, cyId: number, dotId: number;

    async function wipe() {
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
    }

    const person = async (name: string, householdId: number, mergedIntoId?: number) =>
        (await prisma.person.create({ data: { name, email: `${name}-${TAG}@example.com`, householdId, mergedIntoId } })).id;

    beforeAll(async () => {
        await wipe();
        const first = await prisma.household.create({ data: { name: `First ${TAG}` } });
        const second = await prisma.household.create({ data: { name: `Second ${TAG}` } });
        adaId = await person('ada', first.id);
        benId = await person('ben', first.id);
        mergedId = await person('merged', first.id, adaId);
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

    it('counts a merged-away person\'s household without returning that person', async () => {
        expect(sorted(await householdOf([mergedId]))).toEqual(sorted([adaId, benId]));
    });

    it('returns nobody for nobody', async () => {
        await expect(householdOf([])).resolves.toEqual([]);
    });

    it('householdsOf maps each person to what householdOf returns for them alone', async () => {
        const households = await householdsOf([adaId, mergedId, dotId, -1]);
        for (const id of [adaId, mergedId, dotId]) expect(sorted(households.get(id) ?? [])).toEqual(sorted(await householdOf([id])));
        expect(households.has(-1)).toBe(false);
        await expect(householdsOf([])).resolves.toEqual(new Map());
    });

    it('householdIds keeps a merged-away member, whose household still conflicts its live members', async () => {
        expect(sorted(await householdIds(benId))).toEqual(sorted([adaId, benId, mergedId]));
        await expect(householdIds(-1)).resolves.toEqual([]);
    });
});
