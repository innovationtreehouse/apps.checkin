// Workflow-mapping route policy (docs/rules/inventory.md, Access). Aggregated by ../registry.ts.
import { defineRoute, type Authorize, type OrderedViewEntry } from '../core';

// Reads admit INVENTORY_MANAGER, FINANCE or BOARD — finance and the board oversee
// spend; none auto-admits sysadmins. Writes are INVENTORY_MANAGER-only. All
// three read roles see `internal` + `public`; the `personal` receiptJson blob is
// granted to no view, so the stripper removes it from every response.
//
// NOT registered here, deliberately:
//   • the intake — the source's org-bearer POST. checkin cannot gate a
//     machine-bearer route; receipt → workflow is the in-process ingestReceipt
//     export.
//   • /api/internal/* — every crossing is an in-process port.
//   • PUT /api/system-data — the source's admin settings route is dropped.
const WORKFLOW_READ: Authorize = { anyRole: ['isInventoryManager', 'isFinance', 'isBoardMember'] };
const WORKFLOW_VIEW: readonly OrderedViewEntry[] = [
    ['isInventoryManager', ['everyones:internal', 'public']],
    ['isFinance', ['everyones:internal', 'public']],
    ['isBoardMember', ['everyones:internal', 'public']],
];
const WORKFLOW_MANAGER_VIEW: readonly OrderedViewEntry[] = [
    ['isInventoryManager', ['everyones:internal', 'public']],
];

// Reads — the parsed projections (workflowSyntheticClassifications.ts), never the blob.
defineRoute({ endpoint: 'GET /api/workflow-mapping/receipts', authorize: WORKFLOW_READ, envelope: null, returns: ['WorkflowReceiptSummary'], orderedView: WORKFLOW_VIEW });
defineRoute({ endpoint: 'GET /api/workflow-mapping/receipts/counts', authorize: WORKFLOW_READ, envelope: null, returns: ['WorkflowReceiptCount'], orderedView: WORKFLOW_VIEW });
defineRoute({ endpoint: 'GET /api/workflow-mapping/receipts/[id]', authorize: WORKFLOW_READ, envelope: null, returns: ['ReceivedReceipt', 'WorkflowReceiptView', 'WorkflowReceiptLineView', 'ReceivedReceiptLineStatus'], orderedView: WORKFLOW_VIEW });
defineRoute({ endpoint: 'GET /api/workflow-mapping/audit-log', authorize: WORKFLOW_READ, envelope: null, returns: ['WorkflowAuditLog'], orderedView: WORKFLOW_VIEW });

// Writes — receipt transitions, then line edits (409 while the receipt is applying or resolved,
// enforced in the library).
defineRoute({ endpoint: 'POST /api/workflow-mapping/receipts/[id]/proceed', authorize: 'inventory-manager', envelope: null, returns: ['ReceivedReceipt'], orderedView: WORKFLOW_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/workflow-mapping/receipts/[id]/apply', authorize: 'inventory-manager', envelope: null, returns: ['ReceivedReceipt'], orderedView: WORKFLOW_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/workflow-mapping/receipts/[id]/retry-apply', authorize: 'inventory-manager', envelope: null, returns: ['ReceivedReceipt'], orderedView: WORKFLOW_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/workflow-mapping/receipts/[id]/lines/[lineStatusId]/associate', authorize: 'inventory-manager', envelope: null, orderedView: WORKFLOW_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/workflow-mapping/receipts/[id]/lines/[lineStatusId]/propose', authorize: 'inventory-manager', envelope: null, returns: ['ReceivedReceiptLineStatus'], orderedView: WORKFLOW_MANAGER_VIEW });
defineRoute({ endpoint: 'POST /api/workflow-mapping/receipts/[id]/lines/[lineStatusId]/non-inventory', authorize: 'inventory-manager', envelope: null, orderedView: WORKFLOW_MANAGER_VIEW });
