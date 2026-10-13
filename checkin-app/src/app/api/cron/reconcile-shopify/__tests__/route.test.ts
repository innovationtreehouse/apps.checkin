/**
 * @jest-environment node
 */
/**
 * GET /api/cron/reconcile-shopify: the expense catch-up step is isolated, so its failure never
 * fails checkin's reconcile. Both steps are mocked; prisma.cronRunLog is stubbed for withCron's stamp.
 */
import { runExpenseCatchUp } from '@inventory/expense';
import { runReconcile } from '@/lib/finance/reconcile';
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('@/lib/finance/reconcile', () => ({ runReconcile: jest.fn() }));
jest.mock('@inventory/expense', () => ({ runExpenseCatchUp: jest.fn() }));

const SECRET = 'cron-secret-under-test';
const RECONCILED = { configured: true, ordersScanned: 2, reversalsRaised: 0, failed: 0 };
const req = () =>
    new Request('http://localhost/api/cron/reconcile-shopify', { headers: { authorization: `Bearer ${SECRET}` } });

describe('GET /api/cron/reconcile-shopify — expense catch-up step', () => {
    const prev = process.env.CRON_SECRET;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.CRON_SECRET = SECRET;
        prisma.cronRunLog.create = jest.fn().mockResolvedValue({});
        prisma.cronRunLog.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
        jest.mocked(runReconcile).mockResolvedValue(RECONCILED);
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prev;
    });

    it('returns the expense counts beside the reconcile result', async () => {
        const counts = {
            intake: { applied: 0, failed: 0 },
            stranded: { checked: 0, failed: 0 },
            catalogEvents: { processed: 0, duplicate: 0, failed: 0 },
            qbPost: 'unbound' as const,
        };
        jest.mocked(runExpenseCatchUp).mockResolvedValue(counts);

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, expense: counts });
    });

    it('a throwing expense step still answers 200 with the reconcile result', async () => {
        jest.mocked(runExpenseCatchUp).mockRejectedValue(new Error('expense db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(req());

        expect(res.status).toBe(200);
        expect(runReconcile).toHaveBeenCalledTimes(1);
        expect(await res.json()).toEqual({ success: true, ...RECONCILED, expense: { status: 'error' } });
        expect(logged).toHaveBeenCalledWith('[reconcile] expense catch-up failed:', expect.any(Error));
        logged.mockRestore();
    });
});
