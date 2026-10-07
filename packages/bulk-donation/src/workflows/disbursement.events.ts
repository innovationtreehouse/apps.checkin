// ── Ownership pipeline ────────────────────────────────────────────────────────
// Fine-grained event; machine decides readiness via allOwnersReady guard.

export type OwnerAssignedEvent = { type: 'OWNER_ASSIGNED'; allReady: boolean };

// ── Processing results (sent by actor after runAccountDetermination executes) ──

export type AccountUnresolvedEvent = { type: 'ACCOUNT_UNRESOLVED' };
export type ProcessSucceededEvent  = { type: 'PROCESS_SUCCEEDED' };

// ── Hold resolution ───────────────────────────────────────────────────────────

export type HoldResubmittedEvent = { type: 'HOLD_RESUBMITTED' };

// ── Union ─────────────────────────────────────────────────────────────────────

export type DisbursementEvent =
  | OwnerAssignedEvent
  | AccountUnresolvedEvent
  | ProcessSucceededEvent
  | HoldResubmittedEvent;

export const EVENTS = {
  OWNER_ASSIGNED: 'OWNER_ASSIGNED',
  PROCESS_SUCCEEDED: 'PROCESS_SUCCEEDED',
  ACCOUNT_UNRESOLVED: 'ACCOUNT_UNRESOLVED',
  HOLD_RESUBMITTED: 'HOLD_RESUBMITTED',
} as const;
