/**
 * @jest-environment node
 */
/**
 * Unit tests for /api/finance-ops/s-read/sync — the deny paths (401 anon / 403 plain
 * member, through the REAL handler() with a mocked session), the unwired-env 503s, the
 * POST's invocation contract, and the GET's status read.
 *
 * The load-bearing test here is "ignores a caller-supplied mode": the trigger
 * Lambda also accepts {"mode":"backfill"}, which submits a Shopify Bulk Operation.
 * The route must never let the body reach the payload.
 */
import type { NextRequest } from 'next/server';
import { GET, POST } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const sendMock = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
    LambdaClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
    InvokeCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

// The mirror is stubbed at the client boundary (the house pattern — see
// finance/__tests__/reconcile.integration.test.ts). Its SQL is covered separately in
// lib/shopifyRead/__tests__/client.test.ts.
const isConfiguredMock = jest.fn(() => true);
const latestSyncRunMock = jest.fn();
jest.mock('@/lib/shopifyRead/client', () => ({
    isConfigured: () => isConfiguredMock(),
    latestSyncRun: () => latestSyncRunMock(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

function req(body?: unknown) {
    return new Request('http://localhost/api/finance-ops/s-read/sync', {
        method: 'POST',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }) as unknown as NextRequest;
}

/** The single InvokeCommand input the route built. */
function invokedWith() {
    return sendMock.mock.calls[0][0].input;
}

const prevFunction = process.env.S_READ_TRIGGER_FUNCTION;

beforeEach(() => {
    jest.clearAllMocks();
    process.env.S_READ_TRIGGER_FUNCTION = 's-read-dev-trigger';
    sendMock.mockResolvedValue({ StatusCode: 200 });
    isConfiguredMock.mockReturnValue(true);
    latestSyncRunMock.mockResolvedValue(null);
});

afterAll(() => {
    process.env.S_READ_TRIGGER_FUNCTION = prevFunction;
});

describe('POST /api/finance-ops/s-read/sync', () => {
    it('401 when unauthenticated, without invoking', async () => {
        mockSession.mockResolvedValue(null);
        const res = await POST(req());
        expect(res.status).toBe(401);
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('403 for a signed-in member without board or sysadmin role, without invoking', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: false } });
        const res = await POST(req());
        expect(res.status).toBe(403);
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('403 for a sysadmin — finance-ops is board-only (issue #1083)', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: true, isBoardMember: false } });
        const res = await POST(req());
        expect(res.status).toBe(403);
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('invokes the configured trigger with a hardcoded incremental mode for a board member', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
        const res = await POST(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(invokedWith().FunctionName).toBe('s-read-dev-trigger');
        expect(JSON.parse(invokedWith().Payload)).toEqual({ mode: 'incremental' });
    });

    it('ignores a caller-supplied mode — the body can never reach the payload', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
        const res = await POST(req({ mode: 'backfill' }));

        expect(res.status).toBe(200);
        expect(JSON.parse(invokedWith().Payload)).toEqual({ mode: 'incremental' });
    });

    it('503 when no trigger function is configured, without invoking', async () => {
        delete process.env.S_READ_TRIGGER_FUNCTION;
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

        const res = await POST(req());
        expect(res.status).toBe(503);
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('500 when the invoke fails', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
        sendMock.mockRejectedValue(new Error('AccessDeniedException'));

        const res = await POST(req());
        expect(res.status).toBe(500);
    });
});

describe('GET /api/finance-ops/s-read/sync', () => {
    const getReq = () => new Request('http://localhost/api/finance-ops/s-read/sync') as unknown as NextRequest;

    it('401 when unauthenticated, without reading the mirror', async () => {
        mockSession.mockResolvedValue(null);
        const res = await GET(getReq());
        expect(res.status).toBe(401);
        expect(latestSyncRunMock).not.toHaveBeenCalled();
    });

    it('403 for a signed-in member without board or sysadmin role, without reading the mirror', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: false } });
        const res = await GET(getReq());
        expect(res.status).toBe(403);
        expect(latestSyncRunMock).not.toHaveBeenCalled();
    });

    it('returns the latest run for a board member', async () => {
        const run = {
            status: 'COMPLETED',
            kind: 'INCREMENTAL',
            startedAt: '2026-07-16T09:00:00.000Z',
            finishedAt: '2026-07-16T09:02:00.000Z',
            counts: { orders: 12 },
            error: null,
        };
        latestSyncRunMock.mockResolvedValue(run);
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

        const res = await GET(getReq());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ run });
    });

    it('returns a null run when the mirror has never synced', async () => {
        latestSyncRunMock.mockResolvedValue(null);
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

        const res = await GET(getReq());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ run: null });
    });

    it('surfaces a non-terminal run verbatim (the page polls on RUNNING)', async () => {
        latestSyncRunMock.mockResolvedValue({
            status: 'RUNNING', kind: 'INCREMENTAL',
            startedAt: '2026-07-16T09:00:00.000Z', finishedAt: null, counts: null, error: null,
        });
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

        expect((await (await GET(getReq())).json()).run.status).toBe('RUNNING');
    });

    it('503 when the MIRROR is unwired, even though the trigger is configured', async () => {
        // The two gates are separate wiring; the GET must not read the trigger's.
        isConfiguredMock.mockReturnValue(false);
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

        const res = await GET(getReq());
        expect(res.status).toBe(503);
        expect(latestSyncRunMock).not.toHaveBeenCalled();
    });

    it('500 when the mirror read fails', async () => {
        latestSyncRunMock.mockRejectedValue(new Error('ECONNREFUSED'));
        mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

        const res = await GET(getReq());
        expect(res.status).toBe(500);
    });
});
