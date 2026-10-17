/**
 * @jest-environment node
 */
/**
 * Unit tier for mintPersonId: the shape of the call (ONE $queryRaw, the three
 * load-bearing clauses present) and that it unwraps `row.value`. The SQL's
 * behaviour is the integration tier's job — mintId.integration.test.ts.
 */
import { mintPersonId } from '@/lib/person/mintId';
import type { TxClient } from '@/lib/db-client';

const makeTx = (value: number) => ({ $queryRaw: jest.fn().mockResolvedValue([{ value }]) });
const sqlOf = (tx: { $queryRaw: jest.Mock }) => (tx.$queryRaw.mock.calls[0][0] as string[]).join(' ? ');

describe('mintPersonId', () => {
    test('returns the counter value from the single row', async () => {
        const tx = makeTx(2503);
        await expect(mintPersonId(tx as unknown as TxClient)).resolves.toBe(2503);
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    // The adapter test's prismaMockTx mocks exactly one $queryRaw; a second round
    // trip here would also mean the mint and the setval could straddle a retry.
    test('is one statement, not two', async () => {
        const tx = makeTx(1);
        await mintPersonId(tx as unknown as TxClient);
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    test('carries the three clauses the semantics depend on', async () => {
        const tx = makeTx(1);
        await mintPersonId(tx as unknown as TxClient);
        const sql = sqlOf(tx);
        // Self-seed: a db-push DB / post-TRUNCATE DB has no counter row.
        expect(sql).toContain('ON CONFLICT');
        // Absorb a foreign high-water mark, and never wind back after a delete —
        // this is what keeps it from being MAX+1.
        expect(sql).toContain('GREATEST');
        // Push the sequence up too, so the next sequence insert can't draw the
        // id we just handed out (the review amendment).
        expect(sql).toContain('setval');
    });
});
