// ── Ownership assignment ──────────────────────────────────────────────────────

export type FlowStartedEvent = {
  type: 'FLOW_STARTED';
  allOwnersResolved: boolean;
};

export type AllOwnersAssignedEvent = { type: 'ALL_OWNERS_ASSIGNED' };

// ── Approval ──────────────────────────────────────────────────────────────────

export type AllApprovalsTerminalEvent = {
  type: 'ALL_APPROVALS_TERMINAL';
  hasCapital: boolean;
  anyRejected: boolean;
};

// ── Capital review ────────────────────────────────────────────────────────────

export type CapitalReviewSubmittedEvent = {
  type: 'CAPITAL_REVIEW_SUBMITTED';
  hasCapitalItems: boolean;
};

// ── Depreciation ──────────────────────────────────────────────────────────────

export type DepreciationSetEvent = { type: 'DEPRECIATION_SET' };

// ── QB ────────────────────────────────────────────────────────────────────────

export type HoldsCreatedEvent  = { type: 'HOLDS_CREATED' };
export type HoldsResolvedEvent = { type: 'HOLDS_RESOLVED' };
export type QbCompleteEvent    = { type: 'QB_COMPLETE' };
export type QbSkippedEvent      = { type: 'QB_SKIPPED' };
export type QbErrorEvent       = { type: 'QB_ERROR' };
export type ResubmitEvent      = { type: 'RESUBMIT' };

// ── Union ─────────────────────────────────────────────────────────────────────

export type ExpenseEvent =
  | FlowStartedEvent
  | AllOwnersAssignedEvent
  | AllApprovalsTerminalEvent
  | CapitalReviewSubmittedEvent
  | DepreciationSetEvent
  | HoldsCreatedEvent
  | HoldsResolvedEvent
  | QbCompleteEvent
  | QbSkippedEvent
  | QbErrorEvent
  | ResubmitEvent;
