/**
 * @jest-environment node
 */
/**
 * The in-kind conflict set and surname warning read a merged-away uploader or recorder, whose row
 * is gone, through the household of the person the merge archive names as their survivor.
 */
import prisma from '@/lib/prisma';
import { householdMembersOf, householdsSharingSurname } from '../donorSurname';

const TAG = 'donor-surname-merge-test';
const goneId = 2_000_000_000;

async function cleanup() {
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    const ids = people.map((p) => p.id);
    await prisma.personMerge.deleteMany({ where: { OR: [{ toId: { in: ids } }, { fromId: goneId }] } });
    await prisma.person.deleteMany({ where: { id: { in: ids } } });
    await prisma.household.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function person(label: string, name: string, householdId: number) {
    return prisma.person.create({ data: { email: `${label}-${TAG}@example.com`, name, householdId } });
}

let survivor: number;
let survivorMate: number;

beforeAll(async () => {
    await cleanup();
    const home = await prisma.household.create({ data: { name: `${TAG} home` } });
    survivor = (await person('survivor', 'Pat New', home.id)).id;
    survivorMate = (await person('mate', 'Sam Okafor', home.id)).id;
    await prisma.personMerge.create({ data: { fromId: goneId, toId: survivor, snapshot: {} } });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("puts the survivor's household in a merged-away uploader's conflict set", async () => {
    expect((await householdMembersOf(prisma, [goneId])).get(goneId)).toEqual(expect.arrayContaining([goneId, survivor, survivorMate]));
});

it("matches the donor's surname against the survivor's household", async () => {
    const checks = [{ personId: goneId, lastName: 'Okafor' }, { personId: goneId, lastName: 'Nobody' }];
    expect(await householdsSharingSurname(prisma, checks)).toEqual([true, false]);
});
