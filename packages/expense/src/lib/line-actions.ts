// What the caller may do on each expense line, and what the line waits on otherwise. Pure: the
// page draws only these acts, so every eligibility rule an act depends on lives here.
import { CLOSED_STATES, SEATS, availableSigners, blockedSeats, boardAuthorizationRefusal, boardFillsProgramSeat, signoffRefusal, type FilledSeat, type Seat, type SignoffFacts } from "./signoff";
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

const SEAT_NAME: Record<Seat, string> = { SUBMITTER: "Submitter", PROGRAM_APPROVER: "Program approver", TREASURER: "Treasurer", BOARD: "Board" };

/** Everyone who could take some part on the line. */
function pool(facts: SignoffFacts): number[] {
  return [...new Set([facts.submitterId, ...facts.approvers, ...facts.finance, ...facts.board])];
}

/** Whether `id` approves the pending line as a bucket approver; a FINANCE override is not counted. */
function approvesAsApprover(facts: SignoffFacts, id: number): boolean {
  return facts.approvers.includes(id) && !facts.conflicted.includes(id);
}

/** Whether the caller may sign `seat`: the sign-off service's checks, in its order. */
function maySign(input: LineActionsInput, seat: Seat, id: number): boolean {
  if (seat === "PROGRAM_APPROVER" && input.approval?.ownerId == null) return false;
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
    if (deciding && approval.status === "pending" && (approver || caller.isFinance)) {
      add("approve", { noteRequired: !approver });
      add("raise-exception", { noteRequired: true });
    }
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
 * Treasurer, then Board; a bucket fix stands alone when the caller has no part to take.
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
      ? others.filter((id) => approvesAsApprover(input.facts, id)).length
      : others.filter((id) => maySign(input, a.seat!, id)).length;
  const parts = acts.filter((a) => a.act === "approve" || a.act === "sign");
  const main = parts.reduce<{ act: LineAction; n: number } | null>((best, a) => {
    const n = rivals(a);
    return best === null || n < best.n ? { act: a, n } : best;
  }, null);
  if (main) main.act.primary = true;
  else if (assign) assign.primary = true;
}

/** The seat goes to a Board member standing in: nobody it belongs to can sign it. */
function standIn(facts: SignoffFacts, filled: FilledSeat[], seat: Seat): boolean {
  if (seat === "SUBMITTER" || seat === "BOARD") return false;
  if (seat === "PROGRAM_APPROVER" && boardFillsProgramSeat(facts)) return true;
  return availableSigners(facts, filled, seat).length === 0;
}

/** Plain status for each open seat or hold the caller has no act on. */
function awaiting(input: LineActionsInput, acts: LineAction[]): string[] {
  const { expense, approval, facts, filled } = input;
  if (expense.backfill) return ["Booked before the app; no sign-off"];
  if (CLOSED_STATES.has(expense.state)) return [];
  const out: string[] = [];
  if (approval?.status === "pending" && expense.state === "owner_approval" && !acts.some((a) => a.act === "approve")) out.push("Awaiting approval");
  if (expense.reimburseeUnknown && input.holds.length > 0) out.push("Held until finance names the reimbursee");
  const blocked = blockedSeats(facts, filled);
  for (const seat of SEATS) {
    if (!input.holds.includes(seat) || acts.some((a) => a.seat === seat)) continue;
    if (blocked.includes(seat)) out.push("Held: no one without a conflict can sign");
    else if (seat === "PROGRAM_APPROVER" && approval?.ownerId == null) out.push("Waiting for Finance to assign a budget bucket");
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
