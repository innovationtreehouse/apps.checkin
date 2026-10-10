// Expense (#1272 §5/§6) route policy. Aggregated by ../registry.ts.
import { defineRoute, type OrderedViewEntry, type Token } from '../core';

// FINANCE and BOARD read the whole surface: money (`internal`), every person id
// and the reimbursee (`pii`), free text and stored payloads (`personal`).
// A bucket approver (a program's leader or treasurer) passes the
// `expense-approver` gate, and the handler filters rows to the buckets the
// caller approves (§5: the narrow read is a route+query concern). On those rows
// the approver sees `internal` only: amounts and state, not who submitted,
// signed or is reimbursed. The sign-off POST admits `catalog-viewer`, the
// receipt-submitter audience, because the submitter fills the first seat; the
// library decides which seat a caller may fill.
// No view lists isSysadmin: Finance Ops excludes sysadmins
// (docs/rules/finance-payments.md). Finance-only actions are `finance`.
//
// NOT registered here, deliberately:
//   • the org-bearer intake POST /api/expenses — checkin cannot gate a
//     machine-bearer route; the orchestrator's S2 call is in-process (§8a).
//   • the source's /api/system-data — SettingsData is not ported (§2).
//   • any QuickBooks OAuth route — consent is an operator CLI step (§9).
const FULL: readonly Token[] = ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'];

const FINANCE_VIEW: readonly OrderedViewEntry[] = [['isFinance', FULL]];
const FINANCE_OR_BOARD_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', FULL],
    ['isBoardMember', FULL],
];
const APPROVER_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', FULL],
    ['isBoardMember', FULL],
    ['authenticated', ['everyones:internal']],
];

const EXPENSE_DETAIL = ['Expense', 'ExpenseLineItem', 'LineItemOwnerApproval', 'ExpenseLineSignoff', 'ExpenseHold', 'ExpenseAuditLog', 'ExpenseFlag'] as const;

// Approver surface: queue, counts, detail and per-line approval. Rows are
// handler-filtered to the caller's buckets. Sign-off admits submitters too.
defineRoute({ endpoint: 'GET /api/expense/expenses', authorize: 'expense-approver', envelope: null, returns: ['Expense'], orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'GET /api/expense/expenses/count', authorize: 'expense-approver', envelope: null, returns: ['ExpenseListCount'], orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'GET /api/expense/expenses/[id]', authorize: 'expense-approver', envelope: null, returns: EXPENSE_DETAIL, orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'GET /api/expense/expenses/[id]/line-item-approvals', authorize: 'expense-approver', envelope: null, returns: ['LineItemOwnerApproval', 'ExpenseBucketView'], orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/approve', authorize: 'expense-approver', envelope: null, returns: ['LineItemOwnerApproval'], orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/raise-exception', authorize: 'expense-approver', envelope: null, returns: ['LineItemOwnerApproval'], orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'GET /api/expense/expenses/[id]/signoffs', authorize: 'expense-approver', envelope: null, returns: ['ExpenseLineSignoffStatus'], orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/line-items/[lineItemId]/signoffs', authorize: 'catalog-viewer', envelope: null, returns: ['ExpenseLineSignoffStatus'], orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'GET /api/expense/queue', authorize: 'expense-approver', envelope: null, returns: ['Expense'], orderedView: APPROVER_VIEW });
defineRoute({ endpoint: 'GET /api/expense/counts', authorize: 'expense-approver', envelope: null, returns: ['ExpenseCounts'], orderedView: APPROVER_VIEW });

// FINANCE or BOARD: reads, settings, and flag checkoff (a flag carries a FINANCE
// or BOARD audience; the library checks the caller holds it).
defineRoute({ endpoint: 'GET /api/expense/expense-holds', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseHold', 'Expense', 'ExpenseLineItem'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/account-mapping', authorize: 'finance-or-board', envelope: null, returns: ['AccountMapping'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/account-mapping/catalog', authorize: 'finance-or-board', envelope: null, returns: ['Category', 'Subcategory'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/qb-accounts', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseQbAccount'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/local-owners', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseBucketView'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/ownership-map', authorize: 'finance-or-board', envelope: null, returns: ['PartOwnerMap', 'ExpenseBucketView'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/provisional-items', authorize: 'finance-or-board', envelope: null, returns: ['ProvisionalItemMap', 'PartOwnerMap', 'ExpenseBucketView'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/expense-events', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseEvent', 'Expense'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/expense-events/count', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseListCount'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/received-expense-payloads', authorize: 'finance-or-board', envelope: null, returns: ['ReceivedExpensePayload'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/qb-exclusions', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseQbMatchExclusion'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/org-settings', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseOrgSettings'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'PUT /api/expense/org-settings', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseOrgSettings'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/expense/flags', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseFlag'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'POST /api/expense/flags/[id]/check-off', authorize: 'finance-or-board', envelope: null, returns: ['ExpenseFlag'], orderedView: FINANCE_OR_BOARD_VIEW });

// FINANCE only.
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/reject', authorize: 'finance', envelope: null, returns: ['LineItemOwnerApproval'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/assign-owner', authorize: 'finance', envelope: null, returns: ['LineItemOwnerApproval'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/finance-assign', authorize: 'finance', envelope: null, returns: ['LineItemOwnerApproval'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/resolve-unknown', authorize: 'finance', envelope: null, returns: ['LineItemOwnerApproval'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/capital-review/submit', authorize: 'finance', envelope: null, returns: ['Expense', 'ExpenseLineItem'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expenses/[id]/set-depreciation-cycle/submit', authorize: 'finance', envelope: null, returns: ['Expense', 'ExpenseLineItem'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/expense/expenses/[id]/reimbursee', authorize: 'finance', envelope: null, returns: ['Expense'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/expense/expense-holds/[expenseId]/line-items/[lineItemId]/account', authorize: 'finance', envelope: null, returns: ['ExpenseLineItem'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/expense-holds/[expenseId]/resubmit', authorize: 'finance', envelope: null, returns: ['Expense'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/account-mapping', authorize: 'finance', envelope: null, returns: ['AccountMapping'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/expense/account-mapping/[id]', authorize: 'finance', envelope: null, returns: ['AccountMapping'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'DELETE /api/expense/account-mapping/[id]', authorize: 'finance', envelope: null, orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/qb-accounts', authorize: 'finance', envelope: null, returns: ['ExpenseQbAccount'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/expense/qb-accounts/[id]', authorize: 'finance', envelope: null, returns: ['ExpenseQbAccount'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'DELETE /api/expense/qb-accounts/[id]', authorize: 'finance', envelope: null, orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/expense/ownership-map', authorize: 'finance', envelope: null, returns: ['PartOwnerMap'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/capital-assets/seed', authorize: 'finance', envelope: null, returns: ['ExpenseCapitalSeedResult'], orderedView: FINANCE_VIEW });
// QuickBooks matching (§9 QB-2): a line's candidates, pick one, create, or exclude.
defineRoute({ endpoint: 'GET /api/expense/line-items/[lineItemId]/qb-candidates', authorize: 'finance', envelope: null, returns: ['ExpenseQbCandidateView'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/line-items/[lineItemId]/qb-match', authorize: 'finance', envelope: null, returns: ['ExpenseLineItem'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/line-items/[lineItemId]/qb-create', authorize: 'finance', envelope: null, returns: ['ExpenseLineItem'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/expense/qb-exclusions', authorize: 'finance', envelope: null, returns: ['ExpenseQbMatchExclusion'], orderedView: FINANCE_VIEW });
