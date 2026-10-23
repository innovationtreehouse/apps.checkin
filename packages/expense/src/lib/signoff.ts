// Sign-off seats on money leaving the org (Financial Policy F2 / F2-COI). Pure rules over facts
// the service gathers through the SignoffDirectory port.

export const SEATS = ["SUBMITTER", "PROGRAM_APPROVER", "TREASURER", "BOARD"] as const;
export type Seat = (typeof SEATS)[number];

/** A reimbursement becomes a Bill; every other line is a card charge (a Purchase). */
export type LineKind = "reimbursement" | "card_charge";

export interface SignoffFacts {
  kind: LineKind;
  submitterId: number;
  /** The line's bucket approvers (program leader + treasurers); empty for an org-level bucket. */
  approvers: number[];
  orgLevel: boolean;
  /** False only for a reimbursement whose known reimbursee holds no org membership. */
  reimburseeIsMember: boolean;
  finance: number[];
  board: number[];
  /** The submitter, the reimbursee, and their households. */
  conflicted: number[];
  /** The line's Program Leader and their household: conflicted for the Treasurer seat. */
  leaderHousehold: number[];
  /** Who named the reimbursee; null when it came with the receipt. They never sign the Treasurer seat. */
  reimburseeSetter: number | null;
  /** Household members of the people already seated on this expense, other than those people. */
  seatedHouseholds: number[];
  /** The line takes the Board seat: a non-Everyday card-charge line without written Board authorization. */
  boardSeat: boolean;
}

export const CLOSED_STATES = new Set(["qb_complete", "qb_skipped", "rejected"]);

export interface FilledSeat {
  seat: Seat;
  signerUserId: number;
}

/**
 * A reimbursement whose reimbursee is not known. Its conflict check cannot run, so it is held
 * from the outbox and takes no sign-off until FINANCE sets the reimbursee.
 */
export function reimburseeUnknown(expense: { needsReimbursement: boolean; backfill: boolean; reimburseePersonId: number | null }): boolean {
  return expense.needsReimbursement && !expense.backfill && expense.reimburseePersonId === null;
}

export function lineKind(expense: { needsReimbursement: boolean }): LineKind {
  return expense.needsReimbursement ? "reimbursement" : "card_charge";
}

export interface EverydayAmounts {
  receiptTotalCents: number;
  unitPricesCents: number[];
}

export interface EverydayLimits {
  everydayTotalLimitCents: number;
  everydayItemLimitCents: number;
}

/** The receipt total is under the total limit and no unit price is over the item limit. */
export function withinEverydayLimits(a: EverydayAmounts, limits: EverydayLimits): boolean {
  return a.receiptTotalCents < limits.everydayTotalLimitCents && a.unitPricesCents.every((p) => p <= limits.everydayItemLimitCents);
}

export interface EverydayFacts {
  /** The amount check, frozen on the expense with the limits in force when it was first made. */
  withinLimits: boolean;
  singleSource: boolean;
  financeNotEveryday: boolean;
}

/** An Everyday purchase: within the frozen limits, not single-source, and not marked by FINANCE. */
export function isEveryday(e: EverydayFacts): boolean {
  return e.withinLimits && !e.singleSource && !e.financeNotEveryday;
}

/**
 * A non-Everyday card-charge line without written Board authorization takes the Board seat. A
 * program bucket's approved budget is that authorization; any other line, including one with no
 * bucket yet, has it only once a Board authorization is recorded, and a blank one counts as none.
 */
export function needsBoardSeat(kind: LineKind, everyday: boolean, programBucket: boolean, boardAuthorization: string | null): boolean {
  return kind === "card_charge" && !everyday && !programBucket && !boardAuthorization?.trim();
}

/**
 * A purchase at or over the Board-review total ($2,000 by policy, Procurement Policy Art. III), of
 * either kind, is held until the Board's approval of it is recorded in words: a Board
 * authorization, or the approved program-budget line that covers it. Being in a program bucket is
 * not enough, and no signature takes its place; a blank record counts as none.
 */
export function needsBoardApproval(receiptTotalCents: number, boardReviewTotalCents: number, boardAuthorization: string | null): boolean {
  return receiptTotalCents >= boardReviewTotalCents && !boardAuthorization?.trim();
}

/** People the Treasurer seat refuses whatever the seat's state: conflicted, the reimbursee's setter, the Program Leader's household. */
function treasurerConflicted(facts: SignoffFacts): Set<number> {
  const out = new Set([...facts.conflicted, ...facts.leaderHousehold]);
  if (facts.reimburseeSetter !== null) out.add(facts.reimburseeSetter);
  return out;
}

/**
 * Why `userId` may not record the Board authorization, or null. Recording is not an approval: a
 * FINANCE holder without a conflict records what the Board decided; with none, a Board member
 * without one.
 */
export function boardAuthorizationRefusal(factsByLine: SignoffFacts[], userId: number): string | null {
  if (factsByLine.length === 0) return "the expense has no lines";
  const blocked = new Set(factsByLine.flatMap((f) => f.conflicted));
  if (blocked.has(userId)) return "someone conflicted on the charge cannot record the Board authorization";
  const { finance, board } = factsByLine[0];
  if (finance.some((id) => !blocked.has(id))) return finance.includes(userId) ? null : "signer does not hold FINANCE";
  return board.includes(userId) ? null : "signer is not a Board member";
}

/**
 * A Board member, not a program approver, fills the program-approver seat for an org-level bucket
 * or a reimbursement owed to a non-member. The Treasurer seat stays.
 */
export function boardFillsProgramSeat(facts: SignoffFacts): boolean {
  return facts.orgLevel || (facts.kind === "reimbursement" && !facts.reimburseeIsMember);
}

/** Who the seat belongs to before any Board substitution. */
function eligible(facts: SignoffFacts, seat: Exclude<Seat, "SUBMITTER">): number[] {
  if (seat === "TREASURER") return facts.finance;
  if (seat === "BOARD") return facts.board;
  return boardFillsProgramSeat(facts) ? [] : facts.approvers;
}

/**
 * Eligible people who can still sign the seat: not conflicted, not in another seat on the line, and
 * not in the household of someone seated on the expense. The Treasurer seat also excludes the
 * reimbursee's setter and the Program Leader's household.
 */
export function availableSigners(facts: SignoffFacts, filled: FilledSeat[], seat: Exclude<Seat, "SUBMITTER">): number[] {
  const blocked = new Set([...facts.conflicted, ...facts.seatedHouseholds, ...filled.filter((f) => f.seat !== seat).map((f) => f.signerUserId)]);
  if (seat === "TREASURER") for (const id of treasurerConflicted(facts)) blocked.add(id);
  return eligible(facts, seat).filter((id) => !blocked.has(id));
}

/** Seats filled by a Board member standing in for a seat nobody eligible could fill; the Board seat is not one. */
function boardSubstitutions(facts: SignoffFacts, filled: FilledSeat[]): number {
  return filled.filter((f) => f.seat !== "SUBMITTER" && !eligible(facts, f.seat).includes(f.signerUserId)).length;
}

/** Policy allows two Board substitutions on a reimbursement, one on a card charge. */
function maxBoardSubstitutions(facts: SignoffFacts): number {
  return facts.kind === "card_charge" ? 1 : 2;
}

/** The line's unfilled seats; the Board seat counts only on a line that takes it. */
export function missingSeats(facts: SignoffFacts, filled: FilledSeat[]): Seat[] {
  const done = new Set(filled.map((f) => f.seat));
  return SEATS.filter((s) => !done.has(s) && (s !== "BOARD" || facts.boardSeat));
}

/**
 * Seats nobody can fill: no eligible signer is available and the Board substitutions are used up,
 * or a Board seat no Board member can take. A card charge that needs a second substitution lands
 * here; it is held and flagged to the board.
 */
export function blockedSeats(facts: SignoffFacts, filled: FilledSeat[]): Seat[] {
  const open = missingSeats(facts, filled).filter((s): s is Exclude<Seat, "SUBMITTER"> => s !== "SUBMITTER");
  const unfillable = open.filter((s) => availableSigners(facts, filled, s).length === 0);
  const needBoard = unfillable.filter((s) => s !== "BOARD");
  const room = maxBoardSubstitutions(facts) - boardSubstitutions(facts, filled);
  return [...needBoard.slice(Math.max(0, room)), ...unfillable.filter((s) => s === "BOARD")];
}

/** Why `signerUserId` may not fill `seat`, or null when the sign-off is allowed. */
export function signoffRefusal(
  facts: SignoffFacts,
  filled: FilledSeat[],
  seat: Seat,
  signerUserId: number,
): string | null {
  if (filled.some((f) => f.seat === seat)) return `seat ${seat} is already filled`;
  if (filled.some((f) => f.signerUserId === signerUserId)) return "signer already fills another seat on this line";

  if (seat === "SUBMITTER") {
    return signerUserId === facts.submitterId ? null : "only the submitter fills the submitter seat";
  }
  if (seat === "BOARD" && !facts.boardSeat) return "this line takes no Board seat";
  if (facts.conflicted.includes(signerUserId)) return "signer is the submitter, the reimbursee, or in their household";
  if (seat === "TREASURER" && signerUserId === facts.reimburseeSetter) return "whoever set the reimbursee cannot fill the Treasurer seat";
  if (seat === "TREASURER" && facts.leaderHousehold.includes(signerUserId)) return "the Program Leader or their household cannot fill the Treasurer seat";
  if (facts.seatedHouseholds.includes(signerUserId)) return "someone in the signer's household already holds a seat on this expense";
  if (seat === "BOARD") return facts.board.includes(signerUserId) ? null : "signer is not a Board member";

  const available = availableSigners(facts, filled, seat);
  if (available.length > 0) {
    return available.includes(signerUserId)
      ? null
      : seat === "TREASURER"
        ? "signer does not hold FINANCE"
        : "signer is not an approver of this line's bucket";
  }
  // Nobody eligible can sign: a non-conflicted Board member fills the seat instead.
  if (!facts.board.includes(signerUserId)) return "signer is not a Board member";
  if (boardSubstitutions(facts, filled) >= maxBoardSubstitutions(facts)) {
    return "no Board substitution left for this line";
  }
  return null;
}
