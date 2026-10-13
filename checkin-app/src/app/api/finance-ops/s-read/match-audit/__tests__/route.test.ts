/**
 * @jest-environment node
 */
/**
 * Unit tests for /api/finance-ops/s-read/match-audit — the deny paths (401 anon /
 * 403 plain member through the REAL withAuth, never running the audit) and the
 * status contract (503 unwired / 200 passthrough / 500 on failure). The audit's
 * bucketing logic itself is covered in lib/finance/__tests__/matchAudit.test.ts.
 */
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const runMatchAuditMock = jest.fn();
jest.mock('@/lib/finance/matchAudit', () => ({
    runMatchAudit: () => runMatchAuditMock(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const req = () => new Request('http://localhost/api/finance-ops/s-read/match-audit');

const HEALTHY = {
    configured: true,
    variantCoverage: { lines: 4, withVariant: 4 },
    configuredVariants: 3,
    orders: [],
    memberships: [],
    enrollments: [],
};

beforeEach(() => {
    jest.clearAllMocks();
    runMatchAuditMock.mockResolvedValue(HEALTHY);
});

it('401 when unauthenticated, without running the audit', async () => {
    mockSession.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(runMatchAuditMock).not.toHaveBeenCalled();
});

it('403 for a signed-in member without the board role, without running the audit', async () => {
    mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: false } });
    expect((await GET(req())).status).toBe(403);
    expect(runMatchAuditMock).not.toHaveBeenCalled();
});

it('403 for a sysadmin who is not on the board, without running the audit', async () => {
    mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: true, isBoardMember: false } });
    expect((await GET(req())).status).toBe(403);
    expect(runMatchAuditMock).not.toHaveBeenCalled();
});

it('returns the audit result for a board member', async () => {
    mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(HEALTHY);
});

it('503 when the mirror is unwired, matching the sibling s-read routes', async () => {
    runMatchAuditMock.mockResolvedValue({ ...HEALTHY, configured: false });
    mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
    expect((await GET(req())).status).toBe(503);
});

it('500 when the audit itself fails', async () => {
    runMatchAuditMock.mockRejectedValue(new Error('mirror read died'));
    mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
    expect((await GET(req())).status).toBe(500);
});
