// Bulk donation route policy (docs/rules/revenue.md, Donations). Aggregated by ../registry.ts.
import { defineFileRoute, defineRoute, type OrderedViewEntry } from '../core';

// Reads admit FINANCE or BOARD (the board acts as finance's superuser); writes
// admit FINANCE only, except the in-kind decision, which also admits BOARD. Both
// see donor identity (`pii`) and the amounts and plumbing (`internal`), except
// on the in-kind decision, settle, QuickBooks-resolve and bucket routes, whose
// responses carry no donor.
// Ops (OPERATIONS or INVENTORY_MANAGER) is admitted only to the no-receipt
// in-kind routes, with no `pii`: it records donors but never reads them back.
// No sysadmin view: Finance Ops excludes sysadmins (docs/rules/revenue.md). No
// model has a scope binding, so `everyones:` is the only scope.
//
// UploadedFile.fileBlob (the raw Benevity CSV) leaves only through the file
// route below, which makes it file-only: every JSON route strips it.
const FINANCE_TOKENS = ['everyones:pii', 'everyones:internal', 'public'] as const;
const FINANCE_OR_BOARD_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', FINANCE_TOKENS],
    ['isBoardMember', FINANCE_TOKENS],
];
const FINANCE_VIEW: readonly OrderedViewEntry[] = [['isFinance', FINANCE_TOKENS]];
const NO_PII_TOKENS = ['everyones:internal', 'public'] as const;
const IN_KIND_READ_VIEW: readonly OrderedViewEntry[] = [
    ...FINANCE_OR_BOARD_VIEW,
    ['isOperations', NO_PII_TOKENS],
    ['isInventoryManager', NO_PII_TOKENS],
];
// A bucket approver (the bucket's owner or a treasurer) passes `expense-approver` and
// gets `internal` only; the route filters rows to the buckets the caller approves.
const BUCKET_APPROVER_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', NO_PII_TOKENS],
    ['isBoardMember', NO_PII_TOKENS],
    ['authenticated', ['everyones:internal']],
];
const DECISION_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', NO_PII_TOKENS],
    ['isBoardMember', NO_PII_TOKENS],
];
const FINANCE_NO_PII_VIEW: readonly OrderedViewEntry[] = [['isFinance', NO_PII_TOKENS]];
const IN_KIND_WRITE_VIEW: readonly OrderedViewEntry[] = [
    ...FINANCE_VIEW,
    ['isOperations', NO_PII_TOKENS],
    ['isInventoryManager', NO_PII_TOKENS],
];

// Reads — FINANCE or BOARD.
defineRoute({ endpoint: 'GET /api/donations/uploaded-files', authorize: 'finance-or-board', envelope: null, returns: ['UploadedFile'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/transactions', authorize: 'finance-or-board', envelope: null, returns: ['Transaction'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/transactions/unassigned', authorize: 'finance-or-board', envelope: null, returns: ['Transaction'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/transactions/[id]', authorize: 'finance-or-board', envelope: null, returns: ['Transaction'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/comment-rules', authorize: 'finance-or-board', envelope: null, returns: ['TransactionCommentRule'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/account-map', authorize: 'finance-or-board', envelope: null, returns: ['AccountMap'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/disbursement-holds', authorize: 'finance-or-board', envelope: null, returns: ['DisbursementHold', 'Transaction'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/disbursement-events', authorize: 'finance-or-board', envelope: null, returns: ['DisbursementEvent'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/nav-counts', authorize: 'finance-or-board', envelope: null, returns: ['DonationNavCounts'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/in-kind/manual', authorize: { anyRole: ['isFinance', 'isBoardMember', 'isOperations', 'isInventoryManager'] }, envelope: null, returns: ['ManualInKindDonation', 'ManualInKindDonationLine'], orderedView: IN_KIND_READ_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/in-kind/queue', authorize: 'finance-or-board', envelope: null, returns: ['InKindQueueItemView'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
// One in-kind gift's page, with its donor, lines and history; same audience as the queue.
defineRoute({ endpoint: 'GET /api/donations/in-kind/receipt/[id]', authorize: 'finance-or-board', envelope: null, returns: ['InKindGiftDetailView'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });
defineRoute({ endpoint: 'GET /api/donations/in-kind/manual/[id]', authorize: 'finance-or-board', envelope: null, returns: ['InKindGiftDetailView'], orderedView: FINANCE_OR_BOARD_VIEW, auditedRead: true });

// The stored upload, served by fileHandler as a text/plain attachment.
defineFileRoute({ endpoint: 'GET /api/donations/uploaded-files/[id]/blob', authorize: 'finance-or-board', orderedView: FINANCE_OR_BOARD_VIEW, file: { model: 'UploadedFile', field: 'fileBlob' }, auditedRead: true });

// Writes — FINANCE only.
defineRoute({ endpoint: 'POST /api/donations/uploaded-files', authorize: 'finance', envelope: null, returns: ['UploadedFile'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'DELETE /api/donations/uploaded-files/[id]/blob', authorize: 'finance', envelope: null, returns: ['UploadedFile'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PATCH /api/donations/transactions/[id]/owner', authorize: 'finance', envelope: null, returns: ['Transaction'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PATCH /api/donations/transactions/[id]/organizational-level', authorize: 'finance', envelope: null, returns: ['Transaction'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'DELETE /api/donations/comment-rules/[id]', authorize: 'finance', envelope: null, orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/donations/account-map', authorize: 'finance', envelope: null, returns: ['AccountMap'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/donations/account-map/[id]', authorize: 'finance', envelope: null, returns: ['AccountMap'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'DELETE /api/donations/account-map/[id]', authorize: 'finance', envelope: null, orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/donations/disbursement-holds/[disbursementId]/resubmit', authorize: 'finance', envelope: null, returns: ['DisbursementHold', 'DisbursementEvent'], orderedView: FINANCE_VIEW });

// No-receipt in-kind entry — FINANCE or ops; never BOARD.
defineRoute({ endpoint: 'POST /api/donations/in-kind/manual', authorize: { anyRole: ['isFinance', 'isOperations', 'isInventoryManager'] }, envelope: null, returns: ['ManualInKindRecordResult'], orderedView: IN_KIND_WRITE_VIEW });
defineRoute({ endpoint: 'POST /api/donations/in-kind/manual/[id]/load-inventory', authorize: { anyRole: ['isFinance', 'isOperations', 'isInventoryManager'] }, envelope: null, orderedView: IN_KIND_WRITE_VIEW });

// In-kind decision (accept, refuse or return) — FINANCE or BOARD. The board
// decides when every finance holder is conflicted; the service refuses a
// conflicted caller. The reply carries no donor, so no view grants `pii`.
defineRoute({ endpoint: 'POST /api/donations/in-kind/receipt/[id]/decision', authorize: 'finance-or-board', envelope: null, returns: ['InKindDecisionView'], orderedView: DECISION_VIEW });
defineRoute({ endpoint: 'POST /api/donations/in-kind/manual/[id]/decision', authorize: 'finance-or-board', envelope: null, returns: ['InKindDecisionView'], orderedView: DECISION_VIEW });

// Settling a receipt gift's anomaly (a withdrawal or a replay conflict) —
// FINANCE only. Settling a withdrawal clears the donor, so no view grants `pii`.
defineRoute({ endpoint: 'POST /api/donations/in-kind/receipt/[id]/settle', authorize: 'finance', envelope: null, returns: ['InKindSettleResult'], orderedView: FINANCE_NO_PII_VIEW });

// Resolving a gift's QuickBooks match (book, skip or match an existing entry) —
// FINANCE only. The reply is the gift's queue item, which carries no donor.
defineRoute({ endpoint: 'POST /api/donations/in-kind/receipt/[id]/qb-resolve', authorize: 'finance', envelope: null, returns: ['InKindQueueItemView'], orderedView: FINANCE_NO_PII_VIEW });
defineRoute({ endpoint: 'POST /api/donations/in-kind/manual/[id]/qb-resolve', authorize: 'finance', envelope: null, returns: ['InKindQueueItemView'], orderedView: FINANCE_NO_PII_VIEW });

// In-kind gifts in the caller's buckets — FINANCE, BOARD or a bucket approver,
// who sees them and does not decide them.
defineRoute({ endpoint: 'GET /api/donations/in-kind/by-bucket', authorize: 'expense-approver', envelope: null, returns: ['InKindBucketGiftView'], orderedView: BUCKET_APPROVER_VIEW, auditedRead: true });
