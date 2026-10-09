// income library (#1283 §6/§7) route policy. Aggregated by ../registry.ts.
import { defineRoute, type OrderedViewEntry } from '../core';

// Reads admit FINANCE or BOARD; resolve, run, category mapping and exclusion
// writes are FINANCE-only. Every income field except a row's `id` is `internal`
// (§7), so both roles get the full internal view. No sysadmin view: Finance Ops
// excludes sysadmins (docs/rules/finance-payments.md).
//
// QB exclusions are GET + POST only — an exclusion is permanent, so there is no
// DELETE. No audit-log route: nothing reads the audit log yet (§6).
const FINANCE_OR_BOARD_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', ['everyones:internal', 'public']],
    ['isBoardMember', ['everyones:internal', 'public']],
];
const FINANCE_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', ['everyones:internal', 'public']],
];

// Reads — FINANCE or BOARD.
defineRoute({ endpoint: 'GET /api/income/payouts', authorize: 'finance-or-board', envelope: null, returns: ['IncomePayoutView'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/income/payouts/[gid]', authorize: 'finance-or-board', envelope: null, returns: ['IncomePayoutView', 'IncomeBalanceTxnView', 'PayoutReconciliation'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/income/reconciliation', authorize: 'finance-or-board', envelope: null, returns: ['PayoutReconciliation'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/income/reconciliation/count', authorize: 'finance-or-board', envelope: null, returns: ['IncomeReconciliationCount'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/income/items', authorize: 'finance-or-board', envelope: null, returns: ['IncomeItemView'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/income/qb-exclusions', authorize: 'finance-or-board', envelope: null, returns: ['IncomeQbMatchExclusion'], orderedView: FINANCE_OR_BOARD_VIEW });

// FINANCE only — the live-QB candidate read, then the writes.
defineRoute({ endpoint: 'GET /api/income/reconciliation/[id]/candidates', authorize: 'finance', envelope: null, returns: ['IncomeQbDepositView'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/income/reconciliation/[id]/resolve', authorize: 'finance', envelope: null, returns: ['PayoutReconciliation'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/income/reconciliation/run', authorize: 'finance', envelope: null, returns: ['IncomeReconciliationCount'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/income/items/[variantId]/category', authorize: 'finance', envelope: null, returns: ['IncomeItemCategory'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'DELETE /api/income/items/[variantId]/category', authorize: 'finance', envelope: null, returns: ['IncomeItemCategory'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/income/qb-exclusions', authorize: 'finance', envelope: null, returns: ['IncomeQbMatchExclusion'], orderedView: FINANCE_VIEW });
