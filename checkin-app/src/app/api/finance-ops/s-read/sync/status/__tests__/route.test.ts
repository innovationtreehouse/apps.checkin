/**
 * @jest-environment node
 */
import type { NextRequest } from 'next/server';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const isConfiguredMock = jest.fn(() => true);
const syncStatusMock = jest.fn();
jest.mock('@/lib/shopifyRead/client', () => ({
    isConfigured: () => isConfiguredMock(),
    syncStatus: () => syncStatusMock(),
}));

const { getServerSession: mockSession } = jest.requireMock<{ getServerSession: jest.Mock }>('next-auth/next');

const getReq = () => new Request('http://localhost/api/finance-ops/s-read/sync/status') as unknown as NextRequest;
const board = { user: { id: 5, isBoardMember: true } };

const daily = { status: 'FAILED', kind: 'INCREMENTAL', startedAt: '2026-11-23T06:00:00.000Z', finishedAt: '2026-11-23T06:05:00.000Z', counts: null, error: 'boom' };
const repair = { status: 'COMPLETED', kind: 'ADMIN', startedAt: '2026-11-23T08:00:00.000Z', finishedAt: '2026-11-23T08:10:00.000Z', counts: { orders: 3 }, error: null };

beforeEach(() => {
    jest.clearAllMocks();
    isConfiguredMock.mockReturnValue(true);
    syncStatusMock.mockResolvedValue({ scheduled: null, running: null, laterRepair: null });
});

describe('GET /api/finance-ops/s-read/sync/status', () => {
    it('401 when unauthenticated, without reading the mirror', async () => {
        mockSession.mockResolvedValue(null);
        const res = await GET(getReq());
        expect(res.status).toBe(401);
        expect(syncStatusMock).not.toHaveBeenCalled();
    });

    it('403 for a signed-in member without board or sysadmin role', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: false } });
        const res = await GET(getReq());
        expect(res.status).toBe(403);
        expect(syncStatusMock).not.toHaveBeenCalled();
    });

    it('returns the daily read and the later repair for a board member', async () => {
        syncStatusMock.mockResolvedValue({ scheduled: daily, running: null, laterRepair: repair });
        mockSession.mockResolvedValue(board);

        const res = await GET(getReq());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ scheduled: daily, running: null, laterRepair: repair });
    });

    it('returns a daily read still running alongside the last finished one', async () => {
        const inFlight = { status: 'RUNNING', kind: 'INCREMENTAL', startedAt: '2026-11-24T06:00:00.000Z', finishedAt: null, counts: null, error: null };
        syncStatusMock.mockResolvedValue({ scheduled: daily, running: inFlight, laterRepair: null });
        mockSession.mockResolvedValue(board);

        const res = await GET(getReq());
        expect(await res.json()).toEqual({ scheduled: daily, running: inFlight, laterRepair: null });
    });

    it('returns nulls when no daily read has finished', async () => {
        mockSession.mockResolvedValue(board);

        const res = await GET(getReq());
        expect(await res.json()).toEqual({ scheduled: null, running: null, laterRepair: null });
    });

    it('503 when the mirror is not wired here', async () => {
        isConfiguredMock.mockReturnValue(false);
        mockSession.mockResolvedValue(board);

        const res = await GET(getReq());
        expect(res.status).toBe(503);
        expect(syncStatusMock).not.toHaveBeenCalled();
    });

    it('500 when the mirror read fails', async () => {
        syncStatusMock.mockRejectedValue(new Error('db down'));
        mockSession.mockResolvedValue(board);

        const res = await GET(getReq());
        expect(res.status).toBe(500);
    });
});
