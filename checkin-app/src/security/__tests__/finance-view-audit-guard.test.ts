/**
 * @jest-environment node
 *
 * B11 guard: every registered GET route and file route that returns a finance
 * model carries `auditedRead`, or is named below with the reason it shows no
 * one else's money. A new finance read that forgets the flag fails here.
 */
import { allFileRoutes, allRoutes } from '@/security/core';
import '@/security/registry';
import * as receiptGenerated from '@/security/generated/receipt-classifications';
import * as expenseGenerated from '@/security/generated/expense-classifications';
import * as incomeGenerated from '@/security/generated/income-classifications';
import * as donationGenerated from '@/security/generated/donation-classifications';
import * as workflowGenerated from '@/security/generated/workflow-classifications';
import * as receiptSynthetic from '@/security/receiptSyntheticClassifications';
import * as expenseSynthetic from '@/security/expenseSyntheticClassifications';
import * as incomeSynthetic from '@/security/incomeSyntheticClassifications';
import * as donationSynthetic from '@/security/donationSyntheticClassifications';
import * as workflowSynthetic from '@/security/workflowSyntheticClassifications';

// The finance libraries' models, plus the checkin models behind the board's payment queue.
const FINANCE_MODELS = new Set<string>([
    ...[
        receiptGenerated, expenseGenerated, incomeGenerated, donationGenerated, workflowGenerated,
        receiptSynthetic, expenseSynthetic, incomeSynthetic, donationSynthetic, workflowSynthetic,
    ].flatMap(source => Object.keys(source.classifications)),
    'PaymentQueueRow',
    'PaymentQueueLiveOrder',
]);

// Payment-plan queues return shared checkin models (ProgramParticipant, OrgMembershipProcess),
// so they are named by endpoint rather than by model.
const FINANCE_ENDPOINTS = new Set([
    'GET /api/finance-ops/payment-plans',
    'GET /api/finance-ops/membership-payment-plans',
]);

const EXEMPT: Record<string, string> = {
    'GET /api/donations/nav-counts': 'count: numbers, no record',
    'GET /api/receipts/queue-counts': 'count: numbers, no record',
    'GET /api/expense/finance-queue/counts': 'count: numbers, no record',
    'GET /api/expense/counts': 'count: numbers, no record',
    'GET /api/expense/expenses/count': 'count: numbers, no record',
    'GET /api/expense/expense-events/count': 'count: numbers, no record',
    'GET /api/income/reconciliation/count': 'count: numbers, no record',
    'GET /api/workflow-mapping/receipts/counts': 'count: numbers, no record',
    'GET /api/receipt-flow/status': 'count: records per flow state, no record',
    'GET /api/donations/account-map': 'set-up: how donations map to the books',
    'GET /api/expense/account-mapping': 'set-up: how expense categories map to accounts',
    'GET /api/expense/qb-accounts': 'set-up: the QuickBooks account list',
    'GET /api/expense/local-owners': 'set-up: the budget buckets',
    'GET /api/expense/ownership-map': 'set-up: which bucket owns which part',
    'GET /api/expense/org-settings': 'set-up: expense settings',
    'GET /api/income/settings': 'set-up: income settings',
    'GET /api/receipts/settings': 'set-up: receipt settings',
    'GET /api/expense/expenses/[id]/reimbursee/options': 'picker: people finance may name as reimbursee, no money',
    'GET /api/expense/expenses/[id]/reimbursee-vendor/options': 'picker: QuickBooks vendors to link, no money',
    'GET /api/receipts/mine': "self-only: the caller's own receipts",
    'GET /api/receipts/reimbursements': "self-only: the caller's own reimbursements",
    'GET /api/receipts/reimbursee-options': 'picker: people a submitter may name, public tier, no money',
};

function financeRead(endpoint: string, models: readonly string[]): boolean {
    return FINANCE_ENDPOINTS.has(endpoint) || models.some(model => FINANCE_MODELS.has(model));
}

describe('finance view audit guard (B11)', () => {
    const reads = [
        ...[...allRoutes()]
            .filter(([endpoint]) => endpoint.startsWith('GET '))
            .map(([endpoint, spec]) => ({ endpoint, models: spec.returns ?? [], audited: spec.auditedRead === true })),
        ...[...allFileRoutes()]
            .map(([endpoint, spec]) => ({ endpoint, models: [spec.file.model], audited: spec.auditedRead === true })),
    ];

    it('flags every finance read that is not exempt', () => {
        const missing = reads
            .filter(r => financeRead(r.endpoint, r.models) && !r.audited && !(r.endpoint in EXEMPT))
            .map(r => r.endpoint);
        expect(missing).toEqual([]);
    });

    it('exempts only finance reads that are registered and unflagged', () => {
        const byEndpoint = new Map(reads.map(r => [r.endpoint, r]));
        const stale = Object.keys(EXEMPT).filter(endpoint => {
            const r = byEndpoint.get(endpoint);
            return !r || r.audited || !financeRead(endpoint, r.models);
        });
        expect(stale).toEqual([]);
    });

    it('flags only finance reads', () => {
        const stray = reads.filter(r => r.audited && !financeRead(r.endpoint, r.models)).map(r => r.endpoint);
        expect(stray).toEqual([]);
    });
});
