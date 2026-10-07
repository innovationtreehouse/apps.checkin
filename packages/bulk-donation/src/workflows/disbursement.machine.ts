import { setup } from 'xstate';
import type { DisbursementEvent } from './disbursement.events';
import type { DisbursementMachineContext } from './disbursement.guards';
import { disbursementGuards } from './disbursement.guards';

export const STATES = {
  AWAITING_OWNERSHIP: 'awaiting_ownership',
  PROCESSING: 'processing',
  ON_HOLD: 'on_hold',
  COMPLETED: 'completed',
} as const;

export const disbursementMachine = setup({
  types: {
    context: {} as DisbursementMachineContext,
    events: {} as DisbursementEvent,
  },
  guards: disbursementGuards,
}).createMachine({
  id: 'disbursement',
  initial: 'awaiting_ownership',
  context: {},

  states: {

    // ── Ownership pipeline ────────────────────────────────────────────────────
    // Each owner assignment sends OWNER_ASSIGNED. The allOwnersReady guard
    // checks event.allReady — computed by the route before sending — and
    // transitions to processing only when all transactions are covered.

    awaiting_ownership: {
      on: {
        OWNER_ASSIGNED: {
          guard: 'allOwnersReady',
          target: 'processing',
        },
      },
    },

    // ── Synthetic processing state ────────────────────────────────────────────
    // Actor enters this state, calls runAccountDetermination, then sends the
    // result event. Never persisted to the database — transitions out immediately.

    processing: {
      on: {
        PROCESS_SUCCEEDED:  { target: 'completed' },
        ACCOUNT_UNRESOLVED: { target: 'on_hold'   },
      },
    },

    // ── Hold state ────────────────────────────────────────────────────────────
    // One or more transactions could not be matched to a unique account map
    // rule (NO_MATCH or MULTIPLE_MATCHES). Finance fixes the account map and
    // resubmits; the disbursement re-enters processing.

    on_hold: {
      on: {
        HOLD_RESUBMITTED: { target: 'processing' },
      },
    },

    // ── Terminal ──────────────────────────────────────────────────────────────

    completed: {
      type: 'final' as const,
    },
  },
});
