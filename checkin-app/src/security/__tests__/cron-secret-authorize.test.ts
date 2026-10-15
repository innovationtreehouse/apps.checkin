/**
 * @jest-environment node
 *
 * `authorize: { cronSecret }` — a cron route admits only a Bearer of its own
 * named secret, fails closed when that secret is unset, and never admits the
 * shared CRON_SECRET or a session.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import type { AuthResult } from '@/types/auth';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';
import { authenticateRequest } from '@/lib/auth';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockAuth = authenticateRequest as jest.MockedFunction<typeof authenticateRequest>;

const ENDPOINT = 'GET /api/cron/qbo-posting';
const URL = 'http://localhost/api/cron/qbo-posting';
const POSTING_SECRET = 'posting-secret-value';
const SHARED_SECRET = 'shared-cron-secret-value';

const ran = jest.fn();
const GET = handler(ENDPOINT, async () => {
    ran();
    return {};
});

function call(authorization?: string) {
    return GET(new NextRequest(URL, { headers: authorization ? { authorization } : {} }));
}

const unauthenticated: AuthResult = { type: 'unauthenticated' };

describe('cronSecret authorize', () => {
    const saved = { posting: process.env.QBO_POSTING_CRON_SECRET, shared: process.env.CRON_SECRET };

    beforeEach(() => {
        ran.mockClear();
        mockAuth.mockResolvedValue(unauthenticated);
        process.env.QBO_POSTING_CRON_SECRET = POSTING_SECRET;
        process.env.CRON_SECRET = SHARED_SECRET;
    });

    afterAll(() => {
        process.env.QBO_POSTING_CRON_SECRET = saved.posting;
        process.env.CRON_SECRET = saved.shared;
    });

    it('registers the posting route on its own secret, with no view', () => {
        const route = getRoute(ENDPOINT);
        expect(route?.authorize).toEqual({ cronSecret: 'qbo-posting' });
        expect(route?.envelope).toBeNull();
        expect(route?.orderedView).toEqual([]);
    });

    it('admits a Bearer of the named secret', async () => {
        const res = await call(`Bearer ${POSTING_SECRET}`);
        expect(res.status).toBe(200);
        expect(ran).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['unset', undefined],
        ['empty', ''],
    ])('fails closed when the secret is %s, even for a matching header', async (_label, value) => {
        if (value === undefined) delete process.env.QBO_POSTING_CRON_SECRET;
        else process.env.QBO_POSTING_CRON_SECRET = value;
        for (const header of [undefined, 'Bearer ', 'Bearer undefined', `Bearer ${POSTING_SECRET}`]) {
            expect((await call(header)).status).toBe(401);
        }
        expect(ran).not.toHaveBeenCalled();
    });

    it.each([
        ['no header', undefined],
        ['a wrong secret', 'Bearer not-the-secret'],
        ['the shared CRON_SECRET', `Bearer ${SHARED_SECRET}`],
        ['the secret without Bearer', POSTING_SECRET],
        ['a secret with a suffix', `Bearer ${POSTING_SECRET}x`],
    ])('refuses %s with 401', async (_label, header) => {
        expect((await call(header)).status).toBe(401);
        expect(ran).not.toHaveBeenCalled();
    });

    it('refuses a sysadmin session that holds no secret', async () => {
        mockAuth.mockResolvedValue({
            type: 'session',
            user: { id: 1, isSysadmin: true, isBoardMember: true, isFinance: true },
        } as AuthResult);
        const res = await call();
        expect(res.status).toBe(403);
        expect(ran).not.toHaveBeenCalled();
    });
});
