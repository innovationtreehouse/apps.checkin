/**
 * @jest-environment node
 */
/**
 * Guard: the three filter-dropdown reads must dedup in SQL, not in the client.
 * Prisma's `distinct` is a client-side filter — it emits a bare SELECT with no
 * DISTINCT and no LIMIT, so every AuditLog row the org has ever written crosses
 * the wire on every load of this page. `groupBy` emits SQL GROUP BY (verified
 * against Postgres 15; numbers in the PR body). This pins the call shape, which
 * is the only thing observable without a live database.
 *
 * withAuth is mocked to a passthrough — the auth gate is not what's under test.
 */
jest.mock('@/lib/auth', () => ({
    withAuth: (_opts: unknown, handler: (req: Request, auth: unknown) => unknown) =>
        (req: Request, auth: unknown) => handler(req, auth),
}));

import { GET } from '../route';
import prisma from '@/lib/prisma';

const groupBy = () => prisma.auditLog.groupBy as unknown as jest.Mock;
const findMany = () => prisma.auditLog.findMany as unknown as jest.Mock;

beforeEach(() => {
    prisma.auditLog.count = jest.fn().mockResolvedValue(0);
    prisma.auditLog.findMany = jest.fn().mockResolvedValue([]);
    prisma.auditLog.groupBy = jest.fn().mockImplementation(({ by }: { by: string[] }) => {
        if (by[0] === 'tableName') return Promise.resolve([{ tableName: 'Visit' }]);
        if (by[0] === 'actorId') return Promise.resolve([{ actorId: 7 }]);
        return Promise.resolve([{ actorSystem: 'cron:nightly' }]);
    });
    prisma.person.findMany = jest.fn().mockResolvedValue([{ id: 7, name: 'Ada' }]);
});

const call = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GET as any)(new Request('http://localhost/api/system-status/audit-log'), {
        type: 'session',
        user: { isSysadmin: true, isBoardMember: false },
    });

describe('GET /api/system-status/audit-log — dropdown reads dedup in SQL', () => {
    it('reads each dropdown column with groupBy', async () => {
        await call();
        const columns = groupBy().mock.calls.map((c) => c[0].by).flat().sort();
        expect(columns).toEqual(['actorId', 'actorSystem', 'tableName']);
    });

    it('never asks Prisma to dedup client-side', async () => {
        await call();
        for (const [args] of findMany().mock.calls) {
            expect(args).not.toHaveProperty('distinct');
        }
    });

    it('still serves the dropdown values it grouped', async () => {
        const body = await (await call()).json();
        expect(body.tables).toEqual(['Visit']);
        expect(body.actors).toEqual([{ id: 7, name: 'Ada' }]);
        expect(body.systemActors).toEqual(['cron:nightly']);
    });
});
