/**
 * @jest-environment node
 */
/**
 * The QuickBooks fault-code table against a real Postgres: one row per code and kind, whose
 * count runs on and whose first-seen date stays put.
 */
import prisma from '@/lib/prisma';
import { recordFaultCodes } from '../qboFaultCodes';

const CODE = '99001';
const OTHER = '99002';

describe('recordFaultCodes (real DB)', () => {
    afterEach(async () => {
        await prisma.qboFaultCodeSeen.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
    });

    it('counts repeat reports on one row per code and kind', async () => {
        await recordFaultCodes({ lane: 'expense posting', kind: 'data', faultCodes: [CODE, OTHER] });
        const [first] = await prisma.qboFaultCodeSeen.findMany({ where: { code: CODE } });
        await recordFaultCodes({ lane: 'bulk-donation in-kind-posting', kind: 'data', faultCodes: [CODE] });
        await recordFaultCodes({ lane: 'expense posting', kind: 'connection', faultCodes: [CODE] });

        const rows = await prisma.qboFaultCodeSeen.findMany({ where: { code: { in: [CODE, OTHER] } }, orderBy: [{ code: 'asc' }, { kind: 'asc' }] });
        expect(rows.map(({ code, kind, count, lastLane }) => ({ code, kind, count, lastLane }))).toEqual([
            { code: CODE, kind: 'connection', count: 1, lastLane: 'expense posting' },
            { code: CODE, kind: 'data', count: 2, lastLane: 'bulk-donation in-kind-posting' },
            { code: OTHER, kind: 'data', count: 1, lastLane: 'expense posting' },
        ]);
        expect(rows[1].firstSeenAt).toEqual(first.firstSeenAt);
    });
});
