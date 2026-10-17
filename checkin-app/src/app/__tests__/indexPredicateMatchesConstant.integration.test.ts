/**
 * @jest-environment node
 */
/**
 * Index-parity drift alarm.
 *
 * The two partial unique indexes are hand-written raw SQL in migrations; the
 * TS in-flight status lists are `IN_FLIGHT_INITIAL` / `IN_FLIGHT_RENEWAL` in
 * lib/membership/lifecycle. Nothing but this test forces them equal. It READS
 * pg_indexes.indexdef (never alters DDL) and asserts each index's
 * `WHERE status = ANY (ARRAY[…])` set equals the constant — turning the old
 * hand-sync comment into an enforced check. The 20260715 migration already had
 * to widen the renewal index by hand to match a TS edit; this catches the next
 * such drift automatically.
 *
 * Requires the migrate-deploy-provisioned integration DB (the partial indexes
 * are migration-only, so a db-push schema would not have them).
 */
import prisma from '@/lib/prisma';
import { IN_FLIGHT_INITIAL, IN_FLIGHT_RENEWAL } from '@/lib/membership/lifecycle';

/** Pull the status literals out of an index's `status = ANY (ARRAY[…])` predicate. */
async function indexStatuses(indexName: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE indexname = ${indexName}
    `;
    if (rows.length === 0) throw new Error(`index ${indexName} not found in pg_indexes (is the test DB migrate-deployed?)`);
    const def = rows[0].indexdef;
    // pg normalizes `status IN (...)` to `status = ANY (ARRAY['A'::"…", 'B'::"…"])`.
    // indexdef is a single line; `.` need not span newlines (no dotAll flag).
    const arr = def.match(/status\s*=\s*ANY\s*\(ARRAY\[(.+?)\]/i);
    if (!arr) throw new Error(`could not find a status ANY(ARRAY[…]) predicate in:\n${def}`);
    return [...arr[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

describe('partial unique index predicates match the IN_FLIGHT_* constants', () => {
    afterAll(async () => {
        await prisma.$disconnect();
    });

    test('membership_one_inflight_initial === IN_FLIGHT_INITIAL', async () => {
        const statuses = await indexStatuses('membership_one_inflight_initial');
        expect(new Set(statuses)).toEqual(new Set(IN_FLIGHT_INITIAL));
    });

    test('membership_one_inflight_renewal === IN_FLIGHT_RENEWAL', async () => {
        const statuses = await indexStatuses('membership_one_inflight_renewal');
        expect(new Set(statuses)).toEqual(new Set(IN_FLIGHT_RENEWAL));
    });
});
