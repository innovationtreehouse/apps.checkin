// What the caller may do on each expense line, and what the line waits on otherwise. Pure: the
// page draws only these acts, so every eligibility rule an act depends on lives here.
import { CLOSED_STATES, SEATS, approvalRefusal, approvesAsStandIn, availableSigners, blockedSeats, boardAuthorizationRefusal, signoffRefusal, takesBoardSeat, type FilledSeat, type Seat, type SignoffFacts } from "./signoff";
import type { LineHold } from "./signoff-facts";

export type LineAct = "approve" | "sign" | "raise-exception" | "reject-exception" | "assign-bucket" | "resolve-bucket";

export interface LineAction {
  act: LineAct;
  /** The seat a `sign` fills. */
  seat?: Seat;
  /** True on at most one act per line: the button on the line. The rest go under More. */
  primary: boolean;
  /** The server refuses the act without a note. */
  noteRequired: boolean;
  /** An approval by a Board member in place of the bucket's approvers. */
  standIn?: boolean;
}

export interface LineActionsCaller {
  id: number;
  isFinance: boolean;
}

export interface LineActionsExpense {
  state: string;
  backfill: boolean;
  /** A reimbursement whose reimbursee is not yet named. */
  reimburseeUnknown: boolean;
}

export interface LineActionsInput {
  caller: LineActionsCaller;
  expense: LineActionsExpense;
  /** The line's bucket approval row; null when the line has none. */
  approval: { status: string; ownerId: number | null } | null;
  facts: SignoffFacts;
  filled: FilledSeat[];
  /** The line's unfilled seats, then the Board's approval when the expense needs it. */
  holds: LineHold[];
}

export interface LineActions {
  actions: LineAction[];
  awaiting: string[];
}

const SEAT_NAME: Record<Seat, string> = { SUBMITTER: "Submitter", TREASURER: "Treasurer", BOARD: "Board" };

/** A pending line, or one finance moved to another bucket, which waits for that bucket's approver. */
export const APPROVABLE = new Set(["pending", "finance_assigned"]);

/** Everyone who could take some part on the line. */
function pool(facts: SignoffFacts): number[] {
  return [...new Set([facts.submitterId, ...facts.approvers, ...facts.finance, ...facts.board])];
}

/** Whether `id` may approve the line: the approve service's checks. */
function mayApprove(input: LineActionsInput, id: number): boolean {
  return input.approval !== null && APPROVABLE.has(input.approval.status) && approvalRefusal(input.facts, input.filled, id) === null;
}

/** Whether the caller may sign `seat`: the sign-off service's checks, in its order. */
function maySign(input: LineActionsInput, seat: Seat, id: number): boolean {
  return signoffRefusal(input.facts, input.filled, seat, id) === null;
}

/** The acts the caller may take on one line, with the main act marked. */
function callerActs(input: LineActionsInput): LineAction[] {
  const { caller, expense, approval, facts } = input;
  const conflicted = facts.conflicted.includes(caller.id);
  const acts: LineAction[] = [];
  const add = (act: LineAct, extra: Partial<LineAction> = {}) => acts.push({ act, primary: false, noteRequired: false, ...extra });

  if (approval && !conflicted) {
    const deciding = expense.state === "owner_approval";
    const approver = facts.approvers.includes(caller.id);
    if (deciding && mayApprove(input, caller.id)) {
      const standIn = approvesAsStandIn(facts, caller.id);
      add("approve", { noteRequired: standIn && !facts.orgLevel, ...(standIn ? { standIn: true } : {}) });
    }
    if (deciding && approval.status === "pending" && (approver || caller.isFinance)) add("raise-exception", { noteRequired: true });
    if (caller.isFinance && deciding && approval.status === "exception_raised") {
      add("assign-bucket");
      add("reject-exception", { noteRequired: true });
    }
    if (caller.isFinance && approval.status === "unknown") add("resolve-bucket");
    else if (caller.isFinance && expense.state === "assign_ownership" && approval.ownerId === null) add("assign-bucket");
  }

  if (!expense.backfill && !CLOSED_STATES.has(expense.state) && !expense.reimburseeUnknown) {
    for (const seat of SEATS) {
      if (input.holds.includes(seat) && maySign(input, seat, caller.id)) add("sign", { seat });
    }
  }

  markPrimary(input, acts);
  return acts;
}

/**
 * The main act. On a line with an exception raised it is Assign bucket. Otherwise it is the part
 * (approve or a seat) with the fewest other people able to take it, ties going approval, then
 * Treasurer, then Board; a bucket fix stands alone when the caller has no part to take. A Board
 * stand-in's approval stays under More while a bucket approver can approve.
 */
function markPrimary(input: LineActionsInput, acts: LineAction[]): void {
  const assign = acts.find((a) => a.act === "assign-bucket" || a.act === "resolve-bucket");
  if (input.approval?.status === "exception_raised" && assign) {
    assign.primary = true;
    return;
  }
  const others = pool(input.facts).filter((id) => id !== input.caller.id);
  const rivals = (a: LineAction): number =>
    a.act === "approve"
      ? others.filter((id) => mayApprove(input, id)).length
      : others.filter((id) => maySign(input, a.seat!, id)).length;
  const bucketCanApprove = input.facts.approvers.some((id) => mayApprove(input, id));
  const parts = acts.filter((a) => (a.act === "approve" && !(a.standIn && bucketCanApprove)) || a.act === "sign");
  const main = parts.reduce<{ act: LineAction; n: number } | null>((best, a) => {
    const n = rivals(a);
    return best === null || n < best.n ? { act: a, n } : best;
  }, null);
  if (main) main.act.primary = true;
  else if (assign) assign.primary = true;
}

/** The Treasurer seat goes to a Board member standing in: no FINANCE holder can sign it. */
function standIn(facts: SignoffFacts, filled: FilledSeat[], seat: Seat): boolean {
  return seat === "TREASURER" && availableSigners(facts, filled, seat).length === 0;
}

/** Plain status for each open seat or hold the caller has no act on. */
function awaiting(input: LineActionsInput, acts: LineAction[]): string[] {
  const { expense, approval, facts, filled } = input;
  if (expense.backfill) return ["Booked before the app; no sign-off"];
  if (CLOSED_STATES.has(expense.state)) return [];
  const out: string[] = [];
  if (approval && APPROVABLE.has(approval.status) && !acts.some((a) => a.act === "approve")) out.push("Awaiting approval");
  if (expense.reimburseeUnknown && input.holds.length > 0) out.push("Held until finance names the reimbursee");
  const blocked = blockedSeats(facts, filled);
  for (const seat of SEATS) {
    if (!input.holds.includes(seat) || acts.some((a) => a.seat === seat)) continue;
    if (blocked.includes(seat)) out.push("Held: no one without a conflict can sign");
    else if (seat === "BOARD" && !facts.boardSeat && takesBoardSeat(facts) && !facts.approved) out.push("Board approval after the line is approved");
    else if (standIn(facts, filled, seat)) out.push("Awaiting a Board stand-in");
    else out.push(`Awaiting ${SEAT_NAME[seat]}`);
  }
  if (input.holds.includes("BOARD_APPROVAL")) out.push("Held until the Board's approval is recorded");
  return [...new Set(out)];
}

/** The caller's acts on one line and what it waits on otherwise. */
export function lineActions(input: LineActionsInput): LineActions {
  const actions = callerActs(input);
  return { actions, awaiting: awaiting(input, actions) };
}

export interface BoardAuthorizationInput {
  callerId: number;
  expense: LineActionsExpense & { boardAuthorization: string | null };
  factsByLine: SignoffFacts[];
  boardApprovalNeeded: boolean;
}

/** Whether the caller may record the Board authorization: the recording service's checks. */
export function mayRecordBoardAuthorization({ callerId, expense, factsByLine, boardApprovalNeeded }: BoardAuthorizationInput): boolean {
  if (expense.backfill || CLOSED_STATES.has(expense.state) || expense.boardAuthorization !== null) return false;
  if (!factsByLine.some((f) => f.boardSeat) && !boardApprovalNeeded) return false;
  if (expense.reimburseeUnknown) return false;
  return boardAuthorizationRefusal(factsByLine, callerId) === null;
}
