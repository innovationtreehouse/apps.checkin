/**
 * @jest-environment node
 */
/**
 * Guards the one exception in jest.setup.js's default `@/lib/prisma` mock.
 *
 * AGENTS.md, unit tier: "These must never hit a real DB — the prisma mock
 * rejects real calls." `mintPersonId` (lib/person/mintId.ts) is the only raw
 * query a unit-tier route can legitimately reach — it runs inside the same
 * transaction as every person.create — so the mock answers that ONE statement
 * and nothing else. Widening the match to any raw query would quietly retire
 * the invariant; this is the test that stops it.
 *
 * Deliberately no `jest.mock('@/lib/prisma')` here: this suite needs the
 * default mock itself, which is the thing under test.
 */
import prisma from '@/lib/prisma';

const raw = prisma.$queryRaw as unknown as (s: TemplateStringsArray | string[]) => Promise<{ value: number }[]>;

describe('unit-tier prisma mock: $queryRaw', () => {
    test('answers the IdCounter mint with an id above any fixture, and increments', async () => {
        const [a] = await raw(['... INSERT INTO "IdCounter" ("name", "value") ...']);
        const [b] = await raw(['... INSERT INTO "IdCounter" ("name", "value") ...']);
        expect(a.value).toBeGreaterThanOrEqual(100000);
        expect(b.value).toBe(a.value + 1);
    });

    test('still rejects every other raw query', async () => {
        await expect(raw(['SELECT * FROM "Person"'])).rejects.toThrow(
            'Unit tests must not call the real Prisma client',
        );
    });
});

describe('unit-tier prisma mock: $executeRaw', () => {
    const exec = prisma.$executeRaw as unknown as (s: string[]) => Promise<number>;

    test('advisory lock is a no-op', async () => {
        await expect(exec(['SELECT pg_advisory_xact_lock(', ', ', ')'])).resolves.toBe(0);
    });

    test('still rejects every other raw execute', async () => {
        await expect(exec(['DELETE FROM "Person"'])).rejects.toThrow(
            'Unit tests must not call the real Prisma client',
        );
    });
});
