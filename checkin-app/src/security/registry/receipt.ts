// Receipt library (#1265 §6) route policy. Aggregated by ../registry.ts.
import { defineFileRoute, defineRoute, type OrderedViewEntry } from '../core';

// Submitters are the catalog-viewer audience (§6, owner decision) and read only
// their own receipts: `their_own` resolves on the row's uploadedByUserId against
// the session id (plan rule 6), and grants no pii, so donor and reimbursee names
// never come back to the uploader. FINANCE acts org-wide; BOARD reads alongside
// FINANCE (finance's superuser) but takes no finance action. Sysadmins get
// nothing extra (finance-payments.md). A route shared by both audiences lists
// isFinance first; the route passes `access: "finance"` to the library exactly
// when that view matched, else `"submitter"`.
const FINANCE = ['everyones:pii', 'everyones:personal', 'everyones:internal'] as const;
const OWN = ['their_own:personal', 'their_own:internal'] as const;

const SUBMITTER_VIEW: readonly OrderedViewEntry[] = [['authenticated', OWN]];
const SHARED_VIEW: readonly OrderedViewEntry[] = [['isFinance', FINANCE], ['authenticated', OWN]];
const SHARED_READ_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', FINANCE],
    ['isBoardMember', FINANCE],
    ['authenticated', OWN],
];
const FINANCE_VIEW: readonly OrderedViewEntry[] = [['isFinance', FINANCE]];
const FINANCE_READ_VIEW: readonly OrderedViewEntry[] = [['isFinance', FINANCE], ['isBoardMember', FINANCE]];

// Submitter only: the caller's own receipts.
defineRoute({ endpoint: 'POST /api/receipts/upload', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView', 'ReceiptLineView'], orderedView: SUBMITTER_VIEW });
defineRoute({ endpoint: 'GET /api/receipts/mine', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SUBMITTER_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/submitter-confirm', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SUBMITTER_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/submitter-discard', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SUBMITTER_VIEW });
defineRoute({ endpoint: 'PUT /api/receipts/[id]/reimbursement', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SUBMITTER_VIEW });
defineRoute({ endpoint: 'PUT /api/receipts/[id]/in-kind', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SUBMITTER_VIEW });

// Shared: a submitter on their own receipt, or FINANCE on any.
defineRoute({ endpoint: 'GET /api/receipts/needs-attention', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SHARED_VIEW });
defineRoute({ endpoint: 'GET /api/receipts/[id]', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView', 'ReceiptLineView'], orderedView: SHARED_READ_VIEW });
defineRoute({ endpoint: 'PATCH /api/receipts/[id]', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SHARED_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/line-items', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptLineView'], orderedView: SHARED_VIEW });
defineRoute({ endpoint: 'PATCH /api/receipts/[id]/line-items/[lineItemId]', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptLineView'], orderedView: SHARED_VIEW });
defineRoute({ endpoint: 'DELETE /api/receipts/[id]/line-items/[lineItemId]', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptLineView'], orderedView: SHARED_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/retry-ocr', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SHARED_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/discard', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SHARED_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/resubmit', authorize: 'catalog-viewer', envelope: null, returns: ['ReceiptView'], orderedView: SHARED_VIEW });

// FINANCE reads (BOARD too).
defineRoute({ endpoint: 'GET /api/receipts', authorize: 'finance-or-board', envelope: null, returns: ['ReceiptView'], orderedView: FINANCE_READ_VIEW });
defineRoute({ endpoint: 'GET /api/receipts/[id]/audit-logs', authorize: 'finance-or-board', envelope: null, returns: ['ReceiptAuditLog'], orderedView: FINANCE_READ_VIEW });
defineRoute({ endpoint: 'GET /api/receipts/settings', authorize: 'finance-or-board', envelope: null, returns: ['ReceiptOrgSettings'], orderedView: FINANCE_READ_VIEW });

// FINANCE actions.
defineRoute({ endpoint: 'POST /api/receipts/[id]/approve', authorize: 'finance', envelope: null, returns: ['ReceiptView'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/reject', authorize: 'finance', envelope: null, returns: ['ReceiptView'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/clear-duplicate', authorize: 'finance', envelope: null, returns: ['ReceiptView'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/restart-flow', authorize: 'finance', envelope: null, returns: ['ReceiptView'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/[id]/push-to-inventory', authorize: 'finance', envelope: null, returns: ['ReceiptPushResult'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/import', authorize: 'finance', envelope: null, returns: ['ReceiptImportResult'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/receipts/settings', authorize: 'finance', envelope: null, returns: ['ReceiptOrgSettings'], orderedView: FINANCE_VIEW });

// Gmail mail queue (phase G): FINANCE only (§2a: the sender address is read by FINANCE alone).
defineRoute({ endpoint: 'GET /api/receipts/mail-items', authorize: 'finance', envelope: null, returns: ['ReceiptMailItem'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/mail-items/[id]/assign', authorize: 'finance', envelope: null, returns: ['ReceiptMailItem'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/receipts/mail-items/[id]/discard', authorize: 'finance', envelope: null, returns: ['ReceiptMailItem'], orderedView: FINANCE_VIEW });

// Files (plan rule 7): the only way receipt bytes leave. Naming each field here
// makes it file-only, so the JSON stripper drops it on every route. Headers are
// fixed by fileHandler per content type: images inline under a CSP sandbox, PDF
// inline without one, text only as an attachment, nosniff on all.
defineFileRoute({
    endpoint: 'GET /api/receipts/[id]/file',
    authorize: 'catalog-viewer',
    orderedView: [['isFinance', ['everyones:pii']], ['isBoardMember', ['everyones:pii']], ['authenticated', ['their_own:pii']]],
    file: { model: 'Receipt', field: 'fileBlob' },
});
defineFileRoute({
    endpoint: 'GET /api/receipts/mail-items/[id]/file',
    authorize: 'finance',
    orderedView: [['isFinance', ['everyones:pii']]],
    file: { model: 'ReceiptMailItem', field: 'fileBlob' },
});
