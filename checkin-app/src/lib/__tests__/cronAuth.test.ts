/**
 * @jest-environment node
 */
/**
 * Unit tests for requireCronSecret — the shared auth gate for all cron routes —
 * and for withCron's run ledger. No DB: Request objects are constructed directly
 * and prisma.cronRunLog is stubbed. This is the primary coverage for cron auth;
 * per-route tests only smoke the valid-token path.
 */
import { NextResponse } from 'next/server';
import { requireCronSecret, withCron } from '@/lib/cronAuth';
import prisma from '@/lib/prisma';

const SECRET = 'unit-cron-secret';

function req(authHeader?: string, url = 'http://localhost/api/cron/anything') {
    return new Request(url, {
        method: 'GET',
        headers: authHeader ? { authorization: authHeader } : {},
    });
}

describe('requireCronSecret', () => {
    const prev = process.env.CRON_SECRET;

    beforeEach(() => {
        process.env.CRON_SECRET = SECRET;
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prev;
    });

    it('returns 401 when the Authorization header is missing', () => {
        const res = requireCronSecret(req());
        expect(res?.status).toBe(401);
    });

    it('returns 401 when the bearer token is wrong', () => {
        const res = requireCronSecret(req('Bearer not-the-secret'));
        expect(res?.status).toBe(401);
    });

    it('returns 401 when CRON_SECRET is not configured', () => {
        delete process.env.CRON_SECRET;
        const res = requireCronSecret(req(`Bearer ${SECRET}`));
        expect(res?.status).toBe(401);
    });

    it('returns 401 on a mismatch of a different length (hashes both to fixed length)', () => {
        // timingSafeEqual throws on unequal-length buffers, but since we now hash both
        // inputs using SHA-256 before comparing, we can safely compare strings of
        // differing lengths without leaking length information or crashing.
        const res = requireCronSecret(req('Bearer short'));
        expect(res?.status).toBe(401);
    });

    it('returns null (authorized) for the valid secret', () => {
        const res = requireCronSecret(req(`Bearer ${SECRET}`));
        expect(res).toBeNull();
    });
});

/**
 * The run ledger. The contract that matters is that recording is INVISIBLE to the
 * job: it must not change what the handler returns, and it must not be able to
 * fail the job. A run that threw has to land as a failure, not go unrecorded.
 */
describe('withCron run ledger', () => {
    const prev = process.env.CRON_SECRET;
    let create: jest.Mock;

    beforeEach(() => {
        process.env.CRON_SECRET = SECRET;
        create = jest.fn().mockResolvedValue({});
        prisma.cronRunLog.create = create;
        prisma.cronRunLog.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prev;
    });

    const authed = (url?: string) => req(`Bearer ${SECRET}`, url);

    it('records a success and returns the handler response untouched', async () => {
        const handler = jest.fn().mockResolvedValue(NextResponse.json({ success: true, checkedOutCount: 3 }));
        const res = await withCron(handler)(authed('http://localhost/api/cron/nightly'));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, checkedOutCount: 3 });
        expect(create).toHaveBeenCalledTimes(1);
        const { data } = create.mock.calls[0][0];
        expect(data).toMatchObject({ job: 'nightly', success: true, error: null });
        expect(data.startedAt).toBeInstanceOf(Date);
    });

    it('derives the job name from the route path, so every cron route is covered', async () => {
        const handler = jest.fn().mockResolvedValue(NextResponse.json({ success: true }));
        await withCron(handler)(authed('http://localhost/api/cron/reconcile-shopify?force=1'));

        expect(create.mock.calls[0][0].data.job).toBe('reconcile-shopify');
    });

    // A handler that returns its own error envelope has not had a healthy run, even
    // though nothing was thrown. No cron route does this today — the ledger just must
    // not start lying the day one does.
    it('records an error-envelope response as a failure, not a success', async () => {
        const handler = jest.fn().mockResolvedValue(NextResponse.json({ error: 'mirror unreachable' }, { status: 503 }));
        const res = await withCron(handler)(authed('http://localhost/api/cron/reconcile-shopify'));

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'mirror unreachable' });
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'reconcile-shopify', success: false, error: 'HTTP 503' });
    });

    // A sweep that isolates per-row failures answers 200 with counts, so the status
    // cannot see them. Without reading the count, a night that checked nobody out
    // lands in the ledger as a clean success and the System Status pill stays green.
    //
    // Recorded as BOTH: the run completed (success), and it was not clean (error).
    // Writing success: false instead would freeze lastSuccessAt on the first
    // permanently-failing row and the badge would call the job "not running".
    it('records a partial sweep as a run that completed AND names what failed', async () => {
        const body = { success: true, failed: 4, facilityClose: { checkedOutCount: 0 } };
        const handler = jest.fn().mockResolvedValue(NextResponse.json(body));
        const res = await withCron(handler)(authed('http://localhost/api/cron/nightly'));

        // The route's own envelope still reaches the caller untouched.
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(body);
        expect(create.mock.calls[0][0].data).toMatchObject({ job: 'nightly', success: true, error: '4 item(s) failed' });
    });

    // The other half of the split: a run that never completed records no success, so
    // staleness still fires on a job that genuinely stopped.
    it('records a handler error envelope as a run that did NOT complete', async () => {
        const handler = jest.fn().mockResolvedValue(NextResponse.json({ error: 'nope' }, { status: 503 }));
        await withCron(handler)(authed('http://localhost/api/cron/nightly'));

        expect(create.mock.calls[0][0].data).toMatchObject({ success: false, error: 'HTTP 503' });
    });

    it('records a clean success when the body reports zero failed rows', async () => {
        const handler = jest.fn().mockResolvedValue(NextResponse.json({ success: true, failed: 0, released: 2 }));
        await withCron(handler)(authed('http://localhost/api/cron/scholarship-grace-expiry'));

        expect(create.mock.calls[0][0].data).toMatchObject({ success: true, error: null });
    });

    it('records a failure and still returns the 500 when the handler throws', async () => {
        // Suppressed locally, NOT via jest.setup.js's global allowlist: a global entry
        // for the wrapper's own logs would silence them in every other cron test too.
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const handler = jest.fn().mockRejectedValue(new Error('sweep exploded'));
            const res = await withCron(handler)(authed('http://localhost/api/cron/nightly'));

            expect(res.status).toBe(500);
            expect(await res.json()).toEqual({ error: 'Internal Server Error' });
            expect(create.mock.calls[0][0].data).toMatchObject({ job: 'nightly', success: false, error: 'sweep exploded' });
            expect(logged).toHaveBeenCalled();
        } finally {
            logged.mockRestore();
        }
    });

    it('does not fail the job when the ledger write itself fails', async () => {
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            prisma.cronRunLog.create = jest.fn().mockRejectedValue(new Error('db down'));
            const handler = jest.fn().mockResolvedValue(NextResponse.json({ success: true, adultDobPurged: 0 }));

            const res = await withCron(handler)(authed('http://localhost/api/cron/nightly'));

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ success: true, adultDobPurged: 0 });
            // The write really did fail — otherwise this test proves nothing.
            expect(logged).toHaveBeenCalledWith('Failed to record cron run:', expect.any(Error));
        } finally {
            logged.mockRestore();
        }
    });

    it('records nothing for an unauthorized call — a 401 is not a run', async () => {
        const handler = jest.fn();
        const res = await withCron(handler)(req('Bearer wrong'));

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });
});
