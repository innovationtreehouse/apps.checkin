// Shopify-mirror (s-read) route policy: the board's payment queue and the
// /api/finance-ops/s-read/* sync, diagnose and match-audit routes. Aggregated by ../registry.ts.
import { defineRoute, type Authorize, type OrderedViewEntry } from '../core';

// Every route admits BOARD only. No sysadmin view: payment and match-audit data
// is the board's (docs/rules/revenue.md). The mirror's raw payloads and
// bulk exports are `secret` and never leave; the buyer columns (`personal`) leave
// only through the match audit, which the board uses to trace unclaimed orders.
const BOARD: Authorize = { anyRole: ['isBoardMember'] };
const BOARD_VIEW: readonly OrderedViewEntry[] = [
    ['isBoardMember', ['everyones:internal', 'public']],
];
// The queue shows the family's contact email (checkin's Person.email tier).
const BOARD_QUEUE_VIEW: readonly OrderedViewEntry[] = [
    ['isBoardMember', ['everyones:pii', 'everyones:internal', 'public']],
];
const BOARD_AUDIT_VIEW: readonly OrderedViewEntry[] = [
    ['isBoardMember', ['everyones:personal', 'everyones:internal', 'public']],
];

defineRoute({ endpoint: 'GET /api/finance-ops/payments', authorize: BOARD, envelope: null, returns: ['PaymentQueueRow', 'PaymentQueueLiveOrder'], orderedView: BOARD_QUEUE_VIEW });
defineRoute({ endpoint: 'GET /api/finance-ops/s-read/sync', authorize: BOARD, envelope: 'run', returns: ['SyncRun'], orderedView: BOARD_VIEW });
defineRoute({ endpoint: 'POST /api/finance-ops/s-read/sync', authorize: BOARD, envelope: null, returns: ['SReadSyncTrigger'], orderedView: BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/finance-ops/s-read/diagnose', authorize: BOARD, envelope: 'steps', returns: ['SReadDiagnoseStep'], orderedView: BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/finance-ops/s-read/match-audit', authorize: BOARD, envelope: null, returns: ['MatchAuditReport', 'MatchAuditVariantCoverage', 'MatchAuditOrderRow', 'MatchAuditMembershipRow', 'MatchAuditEnrollmentRow'], orderedView: BOARD_AUDIT_VIEW });
defineRoute({ endpoint: 'POST /api/finance-ops/s-read/match-audit/track', authorize: BOARD, envelope: null, returns: ['MatchAuditTrackResult'], orderedView: BOARD_VIEW });
