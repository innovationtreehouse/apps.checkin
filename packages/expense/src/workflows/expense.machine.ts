import { setup } from 'xstate';
import type { ExpenseEvent } from './expense.events';
import type { ExpenseMachineContext } from './expense.guards';
import { expenseGuards } from './expense.guards';

export const expenseMachine = setup({
  types: {
    context: {} as ExpenseMachineContext,
    events: {} as ExpenseEvent,
  },
  guards: expenseGuards,
}).createMachine({
  id: 'expense',
  initial: 'pending',
  context: {
    hasCapital: false,
  },

  states: {

    // ── Entry state ─────────────────────────────────────────────────────────
    // Service calls initFinancialFlow after inserting the expense, then sends
    // FLOW_STARTED. Machine branches on whether all owners were auto-resolved.

    pending: {
      on: {
        FLOW_STARTED: [
          { guard: 'allOwnersResolved', target: 'owner_approval'  },
          {                             target: 'assign_ownership' },
        ],
      },
    },

    // ── Ownership assignment ────────────────────────────────────────────────

    assign_ownership: {
      on: {
        ALL_OWNERS_ASSIGNED: { target: 'owner_approval' },
      },
    },

    // ── Owner approval ──────────────────────────────────────────────────────

    owner_approval: {
      on: {
        ALL_APPROVALS_TERMINAL: [
          { guard: 'anyRejected', target: 'rejected'       },
          { guard: 'hasCapital',  target: 'capital_review' },
          {                       target: 'qb_pending'     },
        ],
      },
    },

    // ── Capital review ──────────────────────────────────────────────────────

    capital_review: {
      on: {
        CAPITAL_REVIEW_SUBMITTED: [
          { guard: 'hasCapitalItems', target: 'set_depreciation_cycle' },
          {                           target: 'qb_pending'             },
        ],
      },
    },

    // ── Depreciation cycle ──────────────────────────────────────────────────

    set_depreciation_cycle: {
      on: {
        DEPRECIATION_SET: { target: 'qb_pending' },
      },
    },

    // ── QB processing ───────────────────────────────────────────────────────

    qb_pending: {
      on: {
        HOLDS_CREATED: { target: 'qb_on_hold' },
        QB_COMPLETE:   { target: 'qb_complete' },
        QB_ERROR:      { target: 'qb_error'    },
        // Historical backfill: already booked in QuickBooks — skip the post, land terminal.
        QB_SKIPPED:    { target: 'qb_skipped'  },
      },
    },

    // ── Blocked on unresolved account-mapping holds ─────────────────────────
    // Entered when checkAndProcessExpense can't match one or more line items
    // to a QB account; returns to qb_pending once finance resolves the holds
    // and a resubmit re-runs the check with zero conflicts.

    qb_on_hold: {
      on: {
        HOLDS_RESOLVED: { target: 'qb_pending' },
        QB_ERROR:       { target: 'qb_error'   },
      },
    },

    qb_error: {
      on: {
        RESUBMIT: { target: 'qb_pending' },
      },
    },

    // ── Terminal ────────────────────────────────────────────────────────────

    qb_complete: {
      type: 'final' as const,
    },

    // Historical backfill terminus: reconciled to an existing QuickBooks transaction, so it was
    // never posted. Capital review + depreciation still ran; only the QB write was skipped.
    qb_skipped: {
      type: 'final' as const,
    },

    // Refused by finance: at least one line-item approval is `rejected`. Terminal,
    // non-proceeding — the expense never books to QuickBooks.
    rejected: {
      type: 'final' as const,
    },
  },
});
