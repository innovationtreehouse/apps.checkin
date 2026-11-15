/**
 * @jest-environment node
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import prisma from '@/lib/prisma';
import { kioskKeyFingerprint } from '@/lib/verify-kiosk';

const KEY = Buffer.alloc(32, 7);
jest.mock('@/lib/verify-kiosk', () => ({
    ...jest.requireActual('@/lib/verify-kiosk'),
    getKioskPublicKeys: () => [Buffer.alloc(32, 7)],
}));

import { GET } from '../route';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const SEEN = [{ keyFingerprint: 'ffffffffffffffff', protocolVersion: 6, lastSeenAt: new Date('2026-11-14T09:00:00.000Z') }];

beforeEach(() => {
    mockSession.mockResolvedValue({
        user: {
            id: 5, isSysadmin: true, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false,
            isOperations: false, isInventoryManager: false, isFinance: false,
        },
        expires: '2099-01-01',
    });
    prisma.kioskProtocolSeen.findMany = jest.fn().mockResolvedValue(SEEN);
});

describe('GET /api/system-status/kiosk-heartbeat', () => {
    it('returns the stored rows and one key row per configured key', async () => {
        const res = await GET(new NextRequest('http://localhost/api/system-status/kiosk-heartbeat'), { params: Promise.resolve({}) });
        expect(res.status).toBe(200);
        const { heartbeat } = await res.json();
        expect(heartbeat.KioskProtocolSeen).toEqual([{ ...SEEN[0], lastSeenAt: '2026-11-14T09:00:00.000Z' }]);
        expect(heartbeat.SystemMetricLog.map((r: { metric: string }) => r.metric))
            .toEqual([`kiosk_key:${kioskKeyFingerprint(KEY)}`]);
    });
});
