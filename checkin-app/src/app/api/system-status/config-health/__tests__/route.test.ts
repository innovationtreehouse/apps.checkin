/**
 * @jest-environment node
 */
/**
 * Auth-gate tests for GET /api/system-status/config-health. withAuth is mocked to a
 * passthrough so GET is the raw handler and we can inject any auth object — the point
 * is the role gate (session + admin/board), not the config computation (unit-tested in
 * lib/__tests__/configHealth.test.ts).
 */
jest.mock('@/lib/auth', () => ({
    withAuth: (_opts: unknown, handler: (req: Request, auth: unknown) => unknown) =>
        (req: Request, auth: unknown) => handler(req, auth),
}));

jest.mock('@/lib/quickbooks/health', () => ({
    getQuickBooksHealth: async () => [{ id: 'quickbooks-connection', label: 'QuickBooks connection', ok: true, detail: 'Connected to the sandbox company.' }],
}));

jest.mock('@/lib/receipt/mailboxHealth', () => ({ getReceiptMailboxHealth: async () => [] }));

jest.mock('@/lib/membership/legacyCheckFlagHealth', () => ({
    legacyCheckFlagCheck: async () => ({ id: 'membership-legacy-check-flag', label: 'Applications on the old household check flag', ok: true, detail: '0.' }),
}));

jest.mock('@/lib/problems', () => ({
    getProblems: async () => ({
        items: [{ library: 'expense', id: 'e1', step: 'intake', href: '/receipts/e1', failedAt: new Date('2026-11-01T12:00:00.000Z') }],
        unread: ['gifts'],
        notices: ['Receipt reading failed 3 times in the last day'],
    }),
}));

import { GET } from '../route';
import prisma from '@/lib/prisma';

const LAST_SUCCESS = new Date('2026-08-06T09:00:00.000Z');

beforeEach(() => {
    prisma.cronRunLog.groupBy = jest.fn().mockResolvedValue([
        { job: 'nightly', _max: { finishedAt: LAST_SUCCESS } },
    ]);
    prisma.cronRunLog.findMany = jest.fn().mockResolvedValue([]);
    prisma.boardSettings.findUnique = jest.fn().mockResolvedValue({ financeAlertEmailAddress: null, boardEmailAddress: 'board@example.org' });
});

const req = () => new Request('http://localhost/api/system-status/config-health');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (auth: any) => (GET as any)(req(), auth);

describe('GET /api/system-status/config-health — auth gate', () => {
    it('401 when not a session', async () => {
        const res = await call({ type: 'kiosk' });
        expect(res.status).toBe(401);
    });

    it('403 for a signed-in normal user (not sysadmin or board)', async () => {
        const res = await call({ type: 'session', user: { isSysadmin: false, isBoardMember: false } });
        expect(res.status).toBe(403);
    });

    it('200 with the checks list for a board member', async () => {
        const res = await call({ type: 'session', user: { isSysadmin: false, isBoardMember: true } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.checks)).toBe(true);
        expect(body.checks.some((c: { id: string }) => c.id === 'zoho-esign')).toBe(true);
        expect(body.checks.some((c: { id: string }) => c.id === 'quickbooks-connection')).toBe(true);
        expect(body.checks.some((c: { id: string }) => c.id === 'membership-legacy-check-flag')).toBe(true);
        // Never leaks secret values — only booleans + labels + detail.
        for (const c of body.checks) {
            expect(typeof c.ok).toBe('boolean');
            expect(Object.keys(c).filter((k) => k !== 'href').sort()).toEqual(['detail', 'id', 'label', 'ok']);
        }
    });

    it('200 for a sysadmin', async () => {
        const res = await call({ type: 'session', user: { isSysadmin: true, isBoardMember: false } });
        expect(res.status).toBe(200);
    });

    it('reports each unset Settings → Email address as a failing check linking to the page', async () => {
        const res = await call({ type: 'session', user: { isSysadmin: false, isBoardMember: true } });
        const body = await res.json();
        expect(body.checks).toContainEqual(expect.objectContaining({ id: 'finance-alert-address', ok: false, href: '/settings/email' }));
        expect(body.checks).toContainEqual(expect.objectContaining({ id: 'board-address', ok: true }));
    });

    it('carries the cron run ledger alongside the config checks', async () => {
        const res = await call({ type: 'session', user: { isSysadmin: false, isBoardMember: true } });
        const body = await res.json();
        expect(body.cronJobs).toEqual([
            { job: 'nightly', lastSuccessAt: LAST_SUCCESS.toISOString(), stale: expect.any(Boolean) },
        ]);
    });

    it('carries the receipt flow problems, the libraries\' own lines, and any library it could not read', async () => {
        const res = await call({ type: 'session', user: { isSysadmin: true, isBoardMember: false } });
        const body = await res.json();
        expect(body.problems).toEqual({
            items: [{ library: 'expense', id: 'e1', step: 'intake', href: '/receipts/e1', failedAt: '2026-11-01T12:00:00.000Z' }],
            unread: ['gifts'],
            notices: ['Receipt reading failed 3 times in the last day'],
        });
    });
});
