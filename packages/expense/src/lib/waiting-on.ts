import { STATE_LABELS } from "./expense-constants";
import type { LineHold } from "./signoff-facts";

/** An expense's state label, as the list and detail routes send it. */
export interface ExpenseWaitingOn {
  expenseId: string;
  label: string;
}

/** What a QB Pending expense waits on, in signing order: the first open hold names it. */
const HOLD_LABELS: [LineHold, string][] = [
  ["SUBMITTER", "Awaiting submitter confirmation"],
  ["TREASURER", "Awaiting Treasurer signature"],
  ["BOARD", "Awaiting Board signature"],
  ["BOARD_APPROVAL", "Awaiting Board approval"],
];

/**
 * The expense's state label. A QB Pending expense the drain holds back shows what it waits on,
 * from the facts the drain checks: an unknown reimbursee, then its lines' unsigned holds.
 */
export function waitingOnLabel(state: string, reimburseeUnknown: boolean, holds: readonly LineHold[]): string {
  if (state === "qb_pending") {
    if (reimburseeUnknown) return "Reimbursee not found";
    const hold = HOLD_LABELS.find(([h]) => holds.includes(h));
    if (hold) return hold[1];
  }
  return STATE_LABELS[state] ?? state;
}
