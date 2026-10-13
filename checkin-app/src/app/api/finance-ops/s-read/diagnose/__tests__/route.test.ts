/**
 * @jest-environment node
 */
/**
 * Unit tests for /api/finance-ops/s-read/diagnose — the deny paths (401 anon /
 * 403 plain member, through the REAL handler() with a mocked session, which must
 * never probe the mirror or the Lambda), and the code→verdict table: each pg
 * error code the mirror probe can throw must map to the layer it proves broken.
 * That table IS the feature — a regression here turns the diagnostic back into
 * the opaque 500 it exists to replace.
 */
import type { NextRequest } from 'next/server';
import { GET } from '../route';
import type { DiagStep } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const sendMock = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
    LambdaClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
    InvokeCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

// Mirror stubbed at the client boundary, same as the sync route's tests — the
// probe SQL itself is covered in lib/shopifyRead/__tests__/client.test.ts.
const countSyncRunsMock = jest.fn();
const latestSyncRunMock = jest.fn();
jest.mock('@/lib/shopifyRead/client', () => ({
    countSyncRuns: () => countSyncRunsMock(),
    latestSyncRun: () => latestSyncRunMock(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const req = () => new Request('http://localhost/api/finance-ops/s-read/diagnose') as unknown as NextRequest;
const asBoard = () => mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

async function stepsOf(res: Response): Promise<Map<string, DiagStep>> {
    const { steps } = await res.json();
    return new Map((steps as DiagStep[]).map((s) => [s.id, s]));
}

const pgError = (code: string) => Object.assign(new Error(`probe failed (${code})`), { code });

const ENV_KEYS = ['DATABASE_URL', 'SHOPIFY_READ_DB', 'SHOPIFY_READ_DATABASE_URL', 'S_READ_TRIGGER_FUNCTION'] as const;
const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
    jest.clearAllMocks();
    // The AWS derivation path: no override, URL built from DATABASE_URL + SHOPIFY_READ_DB.
    delete process.env.SHOPIFY_READ_DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://checkin_dev_dml:secret@db.example.internal:5432/checkin_dev';
    process.env.SHOPIFY_READ_DB = 'shopify_read_dev';
    process.env.S_READ_TRIGGER_FUNCTION = 's-read-dev-trigger';
    countSyncRunsMock.mockResolvedValue(3);
    latestSyncRunMock.mockResolvedValue({
        status: 'COMPLETED', kind: 'INCREMENTAL',
        startedAt: new Date(Date.now() - 12 * 60000), finishedAt: new Date(Date.now() - 10 * 60000),
        counts: { orders: 12 }, error: null,
    });
    sendMock.mockResolvedValue({ StatusCode: 204 });
});

afterAll(() => {
    for (const k of ENV_KEYS) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
    }
});

describe('GET /api/finance-ops/s-read/diagnose — deny paths', () => {
    it('401 when unauthenticated, without probing anything', async () => {
        mockSession.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
        expect(countSyncRunsMock).not.toHaveBeenCalled();
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('403 for a signed-in member without board or sysadmin role, without probing anything', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: false } });
        expect((await GET(req())).status).toBe(403);
        expect(countSyncRunsMock).not.toHaveBeenCalled();
        expect(sendMock).not.toHaveBeenCalled();
    });
});

describe('env step', () => {
    it('reports host + db name for the derived path, never the credential', async () => {
        asBoard();
        const steps = await stepsOf(await GET(req()));
        const env = steps.get('env')!;
        expect(env.ok).toBe(true);
        expect(env.detail).toContain('shopify_read_dev');
        expect(env.detail).toContain('db.example.internal');
        expect(env.detail).not.toContain('secret');
        expect(env.detail).not.toContain('checkin_dev_dml');
    });

    it('unset SHOPIFY_READ_DB → env fails naming it, mirror steps skipped, trigger still probed', async () => {
        delete process.env.SHOPIFY_READ_DB;
        asBoard();
        const steps = await stepsOf(await GET(req()));
        expect(steps.get('env')!.ok).toBe(false);
        expect(steps.get('env')!.detail).toContain('SHOPIFY_READ_DB');
        expect(steps.get('mirror-read')!.ok).toBeNull();
        expect(steps.get('latest-run')!.ok).toBeNull();
        expect(steps.get('clock')!.ok).toBeNull();
        expect(countSyncRunsMock).not.toHaveBeenCalled();
        // The two sides are separate wiring — a missing mirror must not hide trigger results.
        expect(steps.get('trigger-invoke')!.ok).toBe(true);
    });
});

describe('mirror-read step — the code→verdict table', () => {
    // Each row: [pg code, fragment the verdict must contain]. This pins the layer
    // diagnosis: get one wrong and the operator is sent to fix the wrong thing.
    const table: [string, RegExp][] = [
        ['ENOTFOUND', /can't reach the mirror host/i],
        ['ECONNREFUSED', /can't reach the mirror host/i],
        ['ETIMEDOUT', /can't reach the mirror host/i],
        ['28P01', /credential was rejected/i],
        ['28000', /credential was rejected/i],
        ['3D000', /"shopify_read_dev" doesn't exist/i],
        ['42P01', /sync_run table is missing/i],
        ['42501', /grant-holder/i],
    ];

    it.each(table)('%s → the matching layer verdict, with the code attached', async (code, fragment) => {
        countSyncRunsMock.mockRejectedValue(pgError(code));
        asBoard();
        const steps = await stepsOf(await GET(req()));
        const probe = steps.get('mirror-read')!;
        expect(probe.ok).toBe(false);
        expect(probe.code).toBe(code);
        expect(probe.detail).toMatch(fragment);
        expect(steps.get('latest-run')!.ok).toBeNull();
    });

    it('codeless pool connect timeout → network verdict', async () => {
        countSyncRunsMock.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
        asBoard();
        const steps = await stepsOf(await GET(req()));
        expect(steps.get('mirror-read')!.ok).toBe(false);
        expect(steps.get('mirror-read')!.detail).toMatch(/timed out connecting/i);
    });

    it('readable but zero runs → "s-read has never started a run", not a grant/network claim', async () => {
        countSyncRunsMock.mockResolvedValue(0);
        asBoard();
        const steps = await stepsOf(await GET(req()));
        expect(steps.get('mirror-read')!.ok).toBe(false);
        expect(steps.get('mirror-read')!.detail).toMatch(/never started a run/i);
        expect(steps.get('latest-run')!.ok).toBeNull();
        expect(latestSyncRunMock).not.toHaveBeenCalled();
    });
});

describe('latest-run + clock steps', () => {
    it('healthy mirror → all six steps ok', async () => {
        asBoard();
        const steps = await stepsOf(await GET(req()));
        for (const id of ['env', 'mirror-read', 'latest-run', 'clock', 'trigger-env', 'trigger-invoke']) {
            expect(steps.get(id)!.ok).toBe(true);
        }
    });

    it("surfaces s-read's own FAILED run and error text — the answer nobody could see before", async () => {
        latestSyncRunMock.mockResolvedValue({
            status: 'FAILED', kind: 'INCREMENTAL',
            startedAt: new Date(Date.now() - 30 * 60000), finishedAt: new Date(Date.now() - 29 * 60000),
            counts: null, error: 'Shopify 429: throttled',
        });
        asBoard();
        const steps = await stepsOf(await GET(req()));
        const latest = steps.get('latest-run')!;
        expect(latest.ok).toBe(false);
        expect(latest.detail).toContain('FAILED');
        expect(latest.detail).toContain('Shopify 429: throttled');
    });

    it('a future startedAt fails the clock step as a timezone regression — the #1041/#1042 bug class', async () => {
        latestSyncRunMock.mockResolvedValue({
            status: 'COMPLETED', kind: 'INCREMENTAL',
            startedAt: new Date(Date.now() + 5 * 3600_000), finishedAt: null, counts: null, error: null,
        });
        asBoard();
        const steps = await stepsOf(await GET(req()));
        expect(steps.get('clock')!.ok).toBe(false);
        expect(steps.get('clock')!.detail).toMatch(/future/i);
        expect(steps.get('clock')!.detail).toMatch(/timezone/i);
    });
});

describe('trigger steps', () => {
    it('probes with a DryRun invocation and no payload — diagnostics must never start a sync', async () => {
        asBoard();
        await GET(req());
        expect(sendMock).toHaveBeenCalledTimes(1);
        const input = sendMock.mock.calls[0][0].input;
        expect(input.FunctionName).toBe('s-read-dev-trigger');
        expect(input.InvocationType).toBe('DryRun');
        expect(input.Payload).toBeUndefined();
    });

    it('AccessDeniedException → IAM verdict', async () => {
        sendMock.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
        asBoard();
        const steps = await stepsOf(await GET(req()));
        const invoke = steps.get('trigger-invoke')!;
        expect(invoke.ok).toBe(false);
        expect(invoke.code).toBe('AccessDeniedException');
        expect(invoke.detail).toMatch(/IAM/);
    });

    it('ResourceNotFoundException → wrong-name/wrong-env verdict', async () => {
        sendMock.mockRejectedValue(Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' }));
        asBoard();
        const steps = await stepsOf(await GET(req()));
        const invoke = steps.get('trigger-invoke')!;
        expect(invoke.ok).toBe(false);
        expect(invoke.detail).toMatch(/misspelled|another environment/i);
    });

    it('unset S_READ_TRIGGER_FUNCTION → trigger-env fails, invoke skipped, mirror still probed', async () => {
        delete process.env.S_READ_TRIGGER_FUNCTION;
        asBoard();
        const steps = await stepsOf(await GET(req()));
        expect(steps.get('trigger-env')!.ok).toBe(false);
        expect(steps.get('trigger-invoke')!.ok).toBeNull();
        expect(sendMock).not.toHaveBeenCalled();
        expect(steps.get('mirror-read')!.ok).toBe(true);
    });
});
