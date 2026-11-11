/**
 * @jest-environment node
 */
/**
 * Integration tests for GET /api/system-status/health.
 *
 * 401/403 (roles: isSysadmin, isBoardMember, isKeyholder) are already covered
 * by authzRoleRejection.integration.test.ts — this file covers the success
 * path: the 30-day, always-30-entries daily bucketing, the median/p90/p99
 * percentile math over `scan_response_time` metrics, days with no samples
 * (count 0, percentiles 0), and the fire-and-forget prune of metrics older
 * than 30 days.
 */

import { GET } from '@/app/api/system-status/health/route';
import prisma from '@/lib/prisma';
import { orgCalendarDay } from '@/lib/time';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'system-health-test';

describe('System status health API', () => {
    let keyholderId: number;
    let householdId: number;
    const metricIds: number[] = [];
    let staleMetricId: number;

    beforeAll(async () => {
        const keyholder = await prisma.person.create({
            data: { email: `keyholder-${TAG}@example.com`, name: 'Keyholder', isKeyholder: true, household: { create: { name: "Test HH" } } },
        });
        keyholderId = keyholder.id;
        householdId = keyholder.householdId;

        // The real POST /api/scan handler writes its OWN scan_response_time rows on
        // every call (route.ts) as a side effect of normal operation — any sibling
        // integration test that exercises the real scan route (e.g. scanAuth,
        // scanConcurrency) sharing this worker's DB leaves real rows behind. This
        // test is the only one asserting on SystemMetricLog counts, so it's safe (and
        // necessary, for the exact-count assertions below) to start from a clean slate.
        await prisma.systemMetricLog.deleteMany({ where: { metric: 'scan_response_time' } });

        // Three samples today: 100, 200, 300ms -> median 200, p90/p99 near 300.
        const today = new Date();
        for (const value of [100, 200, 300]) {
            const m = await prisma.systemMetricLog.create({
                data: { metric: 'scan_response_time', value, timestamp: today },
            });
            metricIds.push(m.id);
        }
        // A non-scan metric on the same day must NOT be counted.
        const other = await prisma.systemMetricLog.create({
            data: { metric: 'other_metric', value: 9999, timestamp: today },
        });
        metricIds.push(other.id);

        // A stale sample (35 days ago) — outside the 30-day window; must be excluded
        // from the response AND get pruned by the route's fire-and-forget cleanup.
        const stale = await prisma.systemMetricLog.create({
            data: { metric: 'scan_response_time', value: 500, timestamp: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000) },
        });
        staleMetricId = stale.id;
    });

    afterAll(async () => {
        await prisma.systemMetricLog.deleteMany({ where: { id: { in: [...metricIds, staleMetricId] } } });
        await prisma.person.deleteMany({ where: { id: keyholderId } });
        await prisma.household.deleteMany({ where: { id: householdId } });
    });

    const callAsKeyholder = async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: keyholderId, isKeyholder: true } });
        const req = new Request('http://localhost:4000/api/system-status/health', { method: 'GET' });
        return GET(req as unknown as import('next/server').NextRequest);
    };

    it('returns exactly 30 days, todays bucket with count/median/p90/p99, and empty days as zeros', async () => {
        const res = await callAsKeyholder();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.days).toHaveLength(30);

        const todayStr = orgCalendarDay().toISOString().split('T')[0];
        const today = data.days.find((d: { date: string }) => d.date === todayStr);
        expect(today).toBeDefined();
        expect(today.count).toBe(3); // the 'other_metric' row must not count
        expect(today.median).toBe(200);
        expect(today.p90).toBeGreaterThanOrEqual(200);
        expect(today.p99).toBeLessThanOrEqual(300);

        // A day with no samples in the window: zeroed out, not just absent.
        const emptyDay = data.days.find((d: { count: number }) => d.count === 0);
        expect(emptyDay).toBeDefined();
        expect(emptyDay.median).toBe(0);
        expect(emptyDay.p90).toBe(0);
        expect(emptyDay.p99).toBe(0);
    });

    it('excludes samples older than 30 days from the response and prunes them', async () => {
        const res = await callAsKeyholder();
        const data = await res.json();
        const total = data.days.reduce((s: number, d: { count: number }) => s + d.count, 0);
        expect(total).toBe(3); // only today's 3 scan_response_time rows

        // The route's cleanup is fire-and-forget (not awaited) — give it a tick.
        await new Promise((r) => setTimeout(r, 200));
        const stillThere = await prisma.systemMetricLog.findUnique({ where: { id: staleMetricId } });
        expect(stillThere).toBeNull();
    });
});
