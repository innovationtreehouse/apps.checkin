// Bulk donation (#1280 §4/§5) route policy. Aggregated by ../registry.ts.
import { defineFileRoute, defineRoute, type OrderedViewEntry } from '../core';

// Reads admit FINANCE or BOARD (the board acts as finance's superuser); writes
// admit FINANCE only. Both see donor identity (`pii`) and the amounts and
// plumbing (`internal`); nobody else is admitted. No sysadmin view: Finance Ops
// excludes sysadmins (docs/rules/finance-payments.md). No model has a scope
// binding, so `everyones:` is the only scope.
//
// UploadedFile.fileBlob (the raw Benevity CSV) leaves only through the file
// route below, which makes it file-only: every JSON route strips it.
const FINANCE_TOKENS = ['everyones:pii', 'everyones:internal', 'public'] as const;
const FINANCE_OR_BOARD_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', FINANCE_TOKENS],
    ['isBoardMember', FINANCE_TOKENS],
];
const FINANCE_VIEW: readonly OrderedViewEntry[] = [['isFinance', FINANCE_TOKENS]];

// Reads — FINANCE or BOARD.
defineRoute({ endpoint: 'GET /api/donations/uploaded-files', authorize: 'finance-or-board', envelope: null, returns: ['UploadedFile'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/transactions', authorize: 'finance-or-board', envelope: null, returns: ['Transaction'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/transactions/unassigned', authorize: 'finance-or-board', envelope: null, returns: ['Transaction'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/transactions/[id]', authorize: 'finance-or-board', envelope: null, returns: ['Transaction'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/comment-rules', authorize: 'finance-or-board', envelope: null, returns: ['TransactionCommentRule'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/account-map', authorize: 'finance-or-board', envelope: null, returns: ['AccountMap'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/disbursement-holds', authorize: 'finance-or-board', envelope: null, returns: ['DisbursementHold', 'Transaction'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/disbursement-events', authorize: 'finance-or-board', envelope: null, returns: ['DisbursementEvent'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/nav-counts', authorize: 'finance-or-board', envelope: null, returns: ['DonationNavCounts'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/disbursement-events/[disbursementId]/qb-candidates', authorize: 'finance-or-board', envelope: null, returns: ['DonationQbCandidateView'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/donations/qb-exclusions', authorize: 'finance-or-board', envelope: null, returns: ['DonationQbMatchExclusion'], orderedView: FINANCE_OR_BOARD_VIEW });

// The stored upload, served by fileHandler as a text/plain attachment.
defineFileRoute({ endpoint: 'GET /api/donations/uploaded-files/[id]/blob', authorize: 'finance-or-board', orderedView: FINANCE_OR_BOARD_VIEW, file: { model: 'UploadedFile', field: 'fileBlob' } });

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
defineRoute({ endpoint: 'POST /api/donations/disbursement-events/[disbursementId]/qb-resolve', authorize: 'finance', envelope: null, returns: ['DisbursementEvent'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/donations/qb-exclusions', authorize: 'finance', envelope: null, returns: ['DonationQbMatchExclusion'], orderedView: FINANCE_VIEW });
