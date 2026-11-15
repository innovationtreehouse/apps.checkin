/**
 * @jest-environment node
 */
/**
 * Admission and view for the System Status kiosk readings (registry.ts):
 * sysadmins and the Board read the in-memory SystemMetricLog readings and the
 * stored KioskProtocolSeen rows whole; every other role is refused. Auth runs
 * through the real authenticateRequest; only next-auth's getServerSession is
 * stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ENDPOINT = 'GET /api/system-status/kiosk-heartbeat';
const METRICS = [{ metric: 'kiosk_last_seen', timestamp: '2026-11-14T09:00:00.000Z', value: 12 }];
const SEEN = [{ keyFingerprint: '0123456789abcdef', protocolVersion: 2, lastSeenAt: '2026-11-14T09:00:00.000Z' }];

type Flag = 'isFinance' | 'isBoardMember' | 'isInventoryManager' | 'isSysadmin' | 'isOperations' | 'isKeyholder';
type Claims = Partial<Record<Flag, boolean>> & { isActiveOrgMember?: boolean; ageBand?: string };

function signIn(claims: Claims) {
    mockSession.mockResolvedValue({
        user: {
            id: 5,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
            isFinance: false,
            ...claims,
        },
        expires: '2099-01-01',
    });
}

async function call(claims: Claims | null, seen: object[] = SEEN) {
    if (claims) signIn(claims);
    else mockSession.mockResolvedValue(null);
    const impl = jest.fn(async () => ({ SystemMetricLog: METRICS, KioskProtocolSeen: seen }));
    const req = new NextRequest('http://localhost/api/system-status/kiosk-heartbeat');
    const res = await handler(ENDPOINT, impl)(req, { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('kiosk heartbeat route', () => {
    it('is registered for SystemMetricLog and KioskProtocolSeen', () => {
        expect(getRoute(ENDPOINT)?.returns).toEqual(['SystemMetricLog', 'KioskProtocolSeen']);
    });

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['BOARD', { isBoardMember: true }],
    ] as const)('lets %s read both arrays whole', async (_who, claims) => {
        const { res } = await call(claims);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ heartbeat: { SystemMetricLog: METRICS, KioskProtocolSeen: SEEN } });
    });

    it('strips a field KioskProtocolSeen does not declare', async () => {
        const { res } = await call({ isSysadmin: true }, [{ ...SEEN[0], publicKey: 'MCowBQYDK2VwAyEA' }]);
        const body = await res.json();
        expect(body.heartbeat.KioskProtocolSeen).toEqual(SEEN);
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['an operations volunteer', { isOperations: true }],
        ['a keyholder', { isKeyholder: true }],
        ['an adult member', { isActiveOrgMember: true, ageBand: 'adult' }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        const { res, impl } = await call(claims);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        const { res, impl } = await call(null);
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
