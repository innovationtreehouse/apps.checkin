/**
 * @jest-environment node
 */
/**
 * The in-kind conflict set and surname warning read a merged-away uploader or recorder
 * through the person they were merged into.
 */
import prisma from '@/lib/prisma';
import { householdMembersOf, householdsSharingSurname } from '../donorSurname';

const TAG = 'donor-surname-merge-test';

async function cleanup() {
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
    const ids = people.map((p) => p.id);
    await prisma.personMerge.deleteMany({ where: { toId: { in: ids } } });
    await prisma.person.updateMany({ where: { id: { in: ids } }, data: { mergedIntoId: null } });
    await prisma.person.deleteMany({ where: { id: { in: ids } } });
    await prisma.household.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function person(label: string, name: string, householdId: number) {
    return prisma.person.create({ data: { email: `${label}-${TAG}@example.com`, name, householdId } });
}

let tombstone: number;
let survivor: number;
let survivorMate: number;

beforeAll(async () => {
    await cleanup();
    const oldHome = await prisma.household.create({ data: { name: `${TAG} old` } });
    const newHome = await prisma.household.create({ data: { name: `${TAG} new` } });
    tombstone = (await person('tombstone', 'Pat Old', oldHome.id)).id;
    survivor = (await person('survivor', 'Pat New', newHome.id)).id;
    survivorMate = (await person('mate', 'Sam Okafor', newHome.id)).id;
    await prisma.person.update({ where: { id: tombstone }, data: { mergedIntoId: survivor } });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("puts a merged person's survivor and the survivor's household in the conflict set", async () => {
    const members = (await householdMembersOf(prisma, [tombstone])).get(tombstone);
    expect(members).toEqual(expect.arrayContaining([tombstone, survivor, survivorMate]));
});

it("matches the donor's surname against the survivor's household", async () => {
    expect(await householdsSharingSurname(prisma, [{ personId: tombstone, lastName: 'Okafor' }])).toEqual([true]);
});

it('follows the merge archive when the tombstone row is gone', async () => {
    const goneId = 2_000_000_000;
    await prisma.personMerge.create({ data: { fromId: goneId, toId: survivor, snapshot: {} } });
    expect((await householdMembersOf(prisma, [goneId])).get(goneId)).toEqual(expect.arrayContaining([goneId, survivor, survivorMate]));
});
