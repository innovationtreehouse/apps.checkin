/**
 * @jest-environment node
 */
/**
 * raiseMembershipPaymentOutcome for a payment on a BLOCKED application: the problem
 * is raised under the process lock, and not at all once the application has
 * activated on that order.
 */
const tx = {
    $queryRaw: jest.fn(),
    orgMembershipProcess: { findUnique: jest.fn() },
};

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }));
jest.mock('@/lib/finance/reconcile/exceptions', () => ({
    raisePaymentException: jest.fn(),
    recordPaymentException: jest.fn(),
    recordReversal: jest.fn(),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaymentException: jest.fn() }));

import { raiseMembershipPaymentOutcome } from '@/lib/finance/reconcile/membership';
import { recordPaymentException } from '@/lib/finance/reconcile/exceptions';
import { notifyBoardPaymentException } from '@/lib/membership/boardAlerts';

const record = recordPaymentException as jest.Mock;
const notify = notifyBoardPaymentException as jest.Mock;
const ref = { shopifyOrderId: '1001', processId: 7 };

beforeEach(() => {
    jest.clearAllMocks();
    record.mockResolvedValue({ kind: 'PAID_WHILE_BLOCKED', severity: 'WARN', exceptionId: 3 });
});

describe('raiseMembershipPaymentOutcome — paid_while_blocked', () => {
    it('raises and notifies while the application is still blocked', async () => {
        tx.orgMembershipProcess.findUnique.mockResolvedValue({ status: 'BLOCKED', shopifyOrderId: '1001' });
        await raiseMembershipPaymentOutcome('paid_while_blocked', ref);
        expect(tx.$queryRaw).toHaveBeenCalled();
        expect(record).toHaveBeenCalledWith(tx, 'PAID_WHILE_BLOCKED', ref);
        expect(notify).toHaveBeenCalledWith('PAID_WHILE_BLOCKED', 'WARN', 3);
    });

    it('raises nothing once the application is ACTIVE on that order', async () => {
        tx.orgMembershipProcess.findUnique.mockResolvedValue({ status: 'ACTIVE', shopifyOrderId: '1001' });
        await raiseMembershipPaymentOutcome('paid_while_blocked', ref);
        expect(record).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('still raises when the application is ACTIVE on a different order', async () => {
        tx.orgMembershipProcess.findUnique.mockResolvedValue({ status: 'ACTIVE', shopifyOrderId: '2002' });
        await raiseMembershipPaymentOutcome('paid_while_blocked', ref);
        expect(record).toHaveBeenCalled();
    });
});
