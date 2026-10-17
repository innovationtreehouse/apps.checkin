/**
 * @jest-environment node
 */
/**
 * Integration tier for mintPersonId against a real Postgres — the SQL semantics
 * the unit tier can't see.
 *
 * Case 1 is the reason the whole change exists: a person id is printed on a
 * badge, so an id must never be reissued. It is also the case that fails the day
 * someone "simplifies" the helper to `MAX(id) + 1`.
 *
 * (jest.setup.js gives this suite TEST_DB_POOL_MAX=2 so case 2's two
 * transactions run on separate connections — then the IdCounter row lock, not
 * pool-1 serialization, is what orders them, as in production.)
 */
import prisma from '@/lib/prisma';
import { mintPersonId } from '@/lib/person/mintId';

const TAG = 'mint-id-test';

async function cleanup() {
    const people = await prisma.person.findMany({
        where: { name: { contains: TAG } },
        select: { id: true, householdId: true },
    });
    await prisma.person.deleteMany({ where: { id: { in: people.map((p) => p.id) } } });
    await prisma.household.deleteMany({ where: { id: { in: [...new Set(people.map((p) => p.householdId))] } } });
}

let householdId: number;

beforeAll(async () => {
    await cleanup();
    householdId = (await prisma.household.create({ data: { name: `${TAG} household` } })).id;
});

afterAll(async () => {
    await cleanup();
    await prisma.household.deleteMany({ where: { id: householdId } });
});

/** Mint and create in one transaction — the shape every converted site uses. */
const mintAndCreate = (label: string) =>
    prisma.$transaction(async (tx) =>
        tx.person.create({ data: { id: await mintPersonId(tx), name: `${label} ${TAG}`, householdId } }),
    );

const maxPersonId = async () =>
    (await prisma.person.aggregate({ _max: { id: true } }))._max.id ?? 0;

describe('mintPersonId (integration)', () => {
    test('1. deleting the highest person does not free their id for reuse', async () => {
        const first = await mintAndCreate('reuse-a');
        await prisma.person.delete({ where: { id: first.id } });
        const second = await mintAndCreate('reuse-b');
        expect(second.id).toBeGreaterThan(first.id);
        if (second.id === first.id) {
            throw new Error('BADGE INVARIANT BROKEN: a deleted person\'s id was reissued.');
        }
    });

    test('2. two concurrent transactions get distinct consecutive ids', async () => {
        let a!: number;
        const first = prisma.$transaction(async (tx) => {
            a = await mintPersonId(tx);
            await new Promise((r) => setTimeout(r, 300)); // hold the counter row lock
            return a;
        });
        await new Promise((r) => setTimeout(r, 100));
        const second = prisma.$transaction(async (tx) => mintPersonId(tx)); // blocks on the lock
        const [x, y] = await Promise.all([first, second]);
        expect(y).toBe(x + 1);
    });

    test('3. a rolled-back mint leaves no gap', async () => {
        const before = await prisma.$transaction(async (tx) => mintPersonId(tx));
        await expect(
            prisma.$transaction(async (tx) => {
                await mintPersonId(tx);
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');
        const after = await prisma.$transaction(async (tx) => mintPersonId(tx));
        expect(after).toBe(before + 1);
    });

    test('4. self-heals when the counter row is missing', async () => {
        // The flow DB (prisma db push, no migrations) and the dev reset's
        // TRUNCATE both leave the table without its seed row.
        await prisma.$executeRaw`DELETE FROM "IdCounter" WHERE "name" = 'person'`;
        const max = await maxPersonId();
        const minted = await prisma.$transaction(async (tx) => mintPersonId(tx));
        expect(minted).toBeGreaterThan(max);
    });

    test('5. absorbs a foreign high-water mark written straight to the sequence', async () => {
        const far = (await maxPersonId()) + 10_000;
        await prisma.person.create({ data: { id: far, name: `foreign ${TAG}`, householdId } });
        const minted = await prisma.$transaction(async (tx) => mintPersonId(tx));
        expect(minted).toBeGreaterThan(far);
    });

    test('6. the counter continues across a reconnect (the Aurora-resume property)', async () => {
        const before = await prisma.$transaction(async (tx) => mintPersonId(tx));
        await prisma.$disconnect();
        const after = await prisma.$transaction(async (tx) => mintPersonId(tx));
        expect(after).toBe(before + 1);
    });

    // The review amendment. Without the setval, a minted row raises MAX(id) while
    // Person_id_seq stays put, so the very next sequence-minted insert — a test
    // fixture, or any site the guard missed — draws the id just handed out and
    // dies on the PK. This is the regression adminParticipants.integration hits.
    test('7. a sequence-minted insert right after a mint gets minted + 1, not a collision', async () => {
        // Precondition — the state a fixture-heavy suite is actually in: the
        // counter level with the table's high-water mark, and the sequence level
        // with it too. Drop the setval from the helper and the next two
        // statements both claim `anchor + 1` and the second dies on the PK.
        const anchor = await mintAndCreate('anchor');
        await prisma.$executeRaw`SELECT setval(pg_get_serial_sequence('"Person"', 'id'), ${anchor.id}::bigint)`;
        const minted = await mintAndCreate('amendment');
        const bySequence = await prisma.person.create({ data: { name: `fixture ${TAG}`, householdId } });
        expect(bySequence.id).toBe(minted.id + 1);
    });
});
