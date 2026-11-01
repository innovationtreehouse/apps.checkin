/**
 * @jest-environment node
 *
 * GET /api/system-status/health buckets scan timings by the organisation's calendar
 * day, not the UTC day. withAuth is a passthrough; the success path against a real
 * database is in systemStatusHealthAPI.integration.test.ts.
 */
jest.mock('@/lib/auth', () => ({
    withAuth: (_opts: unknown, handler: (req: Request) => unknown) => handler,
}));

import type { NextRequest } from 'next/server';
import { GET } from '../route';
import prisma from '@/lib/prisma';

interface DayStat {
    date: string;
    count: number;
    median: number;
}

const daysAt = async (now: string): Promise<DayStat[]> => {
    jest.useFakeTimers().setSystemTime(new Date(now));
    prisma.systemMetricLog.findMany = jest.fn().mockResolvedValue([{ value: 120, timestamp: new Date(now) }]);
    prisma.systemMetricLog.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const res = await GET(new Request('http://localhost/api/system-status/health') as unknown as NextRequest);
    return (await res.json()).days;
};

afterEach(() => {
    jest.useRealTimers();
});

describe('GET /api/system-status/health day buckets', () => {
    it.each([
        ['summer evening, 7:30 PM CDT', '2026-07-24T00:30:00.000Z', '2026-07-23', '2026-06-24'],
        ['winter evening, 11:30 PM CST', '2026-01-15T05:30:00.000Z', '2026-01-14', '2025-12-16'],
    ])('files a %s under the org day, ending the window there', async (_name, now, orgDay, firstDay) => {
        const days = await daysAt(now);

        expect(days).toHaveLength(30);
        expect(days[0].date).toBe(firstDay);
        expect(days[29]).toMatchObject({ date: orgDay, count: 1, median: 120 });
    });

    it('keeps 30 consecutive days across a clock change', async () => {
        const days = await daysAt('2026-03-20T00:30:00.000Z');

        expect(days[0].date).toBe('2026-02-18');
        expect(days[29].date).toBe('2026-03-19');
        expect(new Set(days.map((d) => d.date)).size).toBe(30);
    });
});
