/**
 * @jest-environment node
 */
/**
 * POST /api/finance-ops/payments/reconcile runs only the Shopify payment check, never
 * the daily cron's other steps, and answers 409 while the daily run holds the lease.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { takeInMailbox } from '@checkin/receipt';
import { runReconcile } from '@/lib/finance/reconcile';
import { POST } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/finance/reconcile', () => ({ runReconcile: jest.fn() }));
jest.mock('@checkin/receipt', () => ({ takeInMailbox: jest.fn() }));

const isConfiguredMock = jest.fn(() => true);
jest.mock('@/lib/shopifyRead/client', () => ({ isConfigured: () => isConfiguredMock() }));

const auditCreateMock = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { auditLog: { create: (...a: unknown[]) => auditCreateMock(...a) } },
}));

const session = jest.mocked(getServerSession);
const reconcile = jest.mocked(runReconcile);
const RESULT = { configured: true, ordersScanned: 4, reversalsRaised: 1, failed: 0 };

const req = () => new Request('http://localhost/api/finance-ops/payments/reconcile', { method: 'POST' }) as unknown as NextRequest;
const asBoard = () => session.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

beforeEach(() => {
    jest.clearAllMocks();
    isConfiguredMock.mockReturnValue(true);
    reconcile.mockResolvedValue(RESULT);
});

describe('POST /api/finance-ops/payments/reconcile', () => {
    it('401 when unauthenticated, without running the check', async () => {
        session.mockResolvedValue(null);
        expect((await POST(req())).status).toBe(401);
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('403 for a signed-in member without the board role, without running the check', async () => {
        session.mockResolvedValue({ user: { id: 5, isSysadmin: true, isBoardMember: false } });
        expect((await POST(req())).status).toBe(403);
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('503 when the mirror is not wired, without running the check', async () => {
        asBoard();
        isConfiguredMock.mockReturnValue(false);
        expect((await POST(req())).status).toBe(503);
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('runs the payment check alone, audited, and returns its counts', async () => {
        asBoard();
        const res = await POST(req());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(RESULT);
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(takeInMailbox).not.toHaveBeenCalled();
        expect(auditCreateMock).toHaveBeenCalledWith({
            data: expect.objectContaining({ actorId: 5, actorSystem: null, tableName: 'SHOPIFY_RECONCILE' }),
        });
    });

    it('409 while the daily run holds the lease', async () => {
        asBoard();
        reconcile.mockResolvedValue({ configured: true, ordersScanned: 0, reversalsRaised: 0, failed: 0, leaseHeld: true });
        expect((await POST(req())).status).toBe(409);
    });

    it('500 when the check throws', async () => {
        asBoard();
        reconcile.mockRejectedValue(new Error('mirror down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect((await POST(req())).status).toBe(500);
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });

    it('500 without running the check when the audit row cannot be written', async () => {
        asBoard();
        auditCreateMock.mockRejectedValueOnce(new Error('db down'));
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect((await POST(req())).status).toBe(500);
        expect(reconcile).not.toHaveBeenCalled();
        logged.mockRestore();
    });
});
