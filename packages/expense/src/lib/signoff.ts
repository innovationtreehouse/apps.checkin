// Sign-off seats on money leaving the org (Financial Policy F2 / F2-COI). Pure rules over facts
// the service gathers through the SignoffDirectory port. The program approver signs a line by
// approving it, so the approval is not a seat.

/** The seats in the order they are signed; the line's approval comes between the first two. */
export const SEATS = ["SUBMITTER", "TREASURER", "BOARD"] as const;
export type Seat = (typeof SEATS)[number];

/** A reimbursement becomes a Bill; every other line is a card charge (a Purchase). */
export type LineKind = "reimbursement" | "card_charge";

export interface SignoffFacts {
  kind: LineKind;
  submitterId: number;
  /** The line's bucket approvers (owner + treasurers); empty for an org-level bucket. */
  approvers: number[];
  orgLevel: boolean;
  /** False only for a reimbursement whose known reimbursee holds no org membership. */
  reimburseeIsMember: boolean;
  /** A reimbursement whose reimbursee is not named yet: nobody signs or approves it until they are. */
  reimburseeUnknown: boolean;
  finance: number[];
  board: number[];
  /** The submitter, the reimbursee, and their households. */
  conflicted: number[];
  /** The line's bucket owner and their household: conflicted for the Treasurer seat. */
  ownerHousehold: number[];
  /** Who named the reimbursee: FINANCE's setter, else the uploader; null while unknown. They never sign the Treasurer seat. */
  reimburseeSetter: number | null;
  /** Household members of the people already seated on this expense, other than those people. */
  seatedHouseholds: number[];
  /** A non-Everyday card-charge line without written Board authorization. */
  boardSeat: boolean;
  /** The line's approval is `approved`: the program approver's sign-off. */
  approved: boolean;
  /** Who approved the line; null while it is not approved, or for a line approved at intake. */
  approver: number | null;
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
}

/** An Everyday purchase: within the frozen limits. The amounts alone decide it. */
export function isEveryday(e: EverydayFacts): boolean {
  return e.withinLimits;
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

/** People the Treasurer seat refuses whatever the seat's state: conflicted, the reimbursee's setter, the bucket owner's household. */
function treasurerConflicted(facts: SignoffFacts): Set<number> {
  const out = new Set([...facts.conflicted, ...facts.ownerHousehold]);
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
 * The line takes the Board seat: a non-Everyday card charge without written Board authorization,
 * or a reimbursement owed to a non-member, whose Board signature follows the line's approval.
 */
export function takesBoardSeat(facts: SignoffFacts): boolean {
  return facts.boardSeat || (facts.kind === "reimbursement" && !facts.reimburseeIsMember);
}

/** Who the seat belongs to before any Board substitution. */
function eligible(facts: SignoffFacts, seat: Exclude<Seat, "SUBMITTER">): number[] {
  return seat === "TREASURER" ? facts.finance : facts.board;
}

/** Whoever approved the line or signs a seat on it, other than `except`. */
function onLine(facts: SignoffFacts, filled: FilledSeat[], except?: Seat): number[] {
  const out = filled.filter((f) => f.seat !== except).map((f) => f.signerUserId);
  return facts.approver === null ? out : [...out, facts.approver];
}

/**
 * Eligible people who can still sign the seat: not conflicted, not the line's approver or in
 * another seat on it, and not in the household of someone seated on the expense. The Treasurer
 * seat also excludes the reimbursee's setter and the bucket owner's household.
 */
export function availableSigners(facts: SignoffFacts, filled: FilledSeat[], seat: Exclude<Seat, "SUBMITTER">): number[] {
  const blocked = new Set([...facts.conflicted, ...facts.seatedHouseholds, ...onLine(facts, filled, seat)]);
  if (seat === "TREASURER") for (const id of treasurerConflicted(facts)) blocked.add(id);
  return eligible(facts, seat).filter((id) => !blocked.has(id));
}

/**
 * Board members standing in for someone nobody eligible could replace: an approval by anyone
 * but a bucket approver, and a Treasurer seat signed by anyone without FINANCE. The Board seat
 * is not one.
 */
function boardSubstitutions(facts: SignoffFacts, filled: FilledSeat[]): number {
  const approval = facts.approver !== null && !facts.approvers.includes(facts.approver) ? 1 : 0;
  return approval + filled.filter((f) => f.seat === "TREASURER" && !facts.finance.includes(f.signerUserId)).length;
}

/** Policy allows two Board substitutions on a reimbursement, one on a card charge. */
function maxBoardSubstitutions(facts: SignoffFacts): number {
  return facts.kind === "card_charge" ? 1 : 2;
}

/** The line's unfilled seats; the Board seat counts only on a line that takes it. */
export function missingSeats(facts: SignoffFacts, filled: FilledSeat[]): Seat[] {
  const done = new Set(filled.map((f) => f.seat));
  return SEATS.filter((s) => !done.has(s) && (s !== "BOARD" || takesBoardSeat(facts)));
}

/**
 * Seats nobody can fill: no eligible signer is available and the Board substitutions are used up,
 * or a Board seat no Board member can take. A card charge that needs a second substitution lands
 * here; it is held, and shows in the finance queue as a held signer.
 */
export function blockedSeats(facts: SignoffFacts, filled: FilledSeat[]): Seat[] {
  const open = missingSeats(facts, filled).filter((s): s is Exclude<Seat, "SUBMITTER"> => s !== "SUBMITTER");
  const unfillable = open.filter((s) => availableSigners(facts, filled, s).length === 0);
  const needBoard = unfillable.filter((s) => s !== "BOARD");
  const room = maxBoardSubstitutions(facts) - boardSubstitutions(facts, filled);
  return [...needBoard.slice(Math.max(0, room)), ...unfillable.filter((s) => s === "BOARD")];
}

const REIMBURSEE_UNKNOWN = "the reimbursee is unknown; FINANCE names them before any sign-off";

/**
 * Why the seat may not be signed yet: nothing is signed while the reimbursee is unknown, the
 * Treasurer signs after the line's approval, and the Board after the Treasurer. A reimbursement
 * line's approval waits for the submitter seat (approvalRefusal).
 */
function orderRefusal(facts: SignoffFacts, filled: FilledSeat[], seat: Seat): string | null {
  if (facts.reimburseeUnknown) return REIMBURSEE_UNKNOWN;
  if (seat === "SUBMITTER") return null;
  if (!facts.approved) return `the line is not approved yet; the ${seat === "TREASURER" ? "Treasurer" : "Board"} signs after its approval`;
  if (seat === "BOARD" && !filled.some((f) => f.seat === "TREASURER")) return "the Treasurer has not signed yet; the Board signs after the Treasurer";
  return null;
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
    if (signerUserId !== facts.submitterId) return "only the submitter fills the submitter seat";
    if (facts.seatedHouseholds.includes(signerUserId)) return "someone in the submitter's household already holds a seat on this expense";
    return orderRefusal(facts, filled, seat);
  }
  if (seat === "BOARD" && !takesBoardSeat(facts)) return "this line takes no Board seat";
  const outOfOrder = orderRefusal(facts, filled, seat);
  if (outOfOrder) return outOfOrder;
  if (signerUserId === facts.approver) return "whoever approved the line does not sign another seat on it";
  if (facts.conflicted.includes(signerUserId)) return "signer is the submitter, the reimbursee, or in their household";
  if (seat === "TREASURER" && signerUserId === facts.reimburseeSetter) return "whoever set the reimbursee cannot fill the Treasurer seat";
  if (seat === "TREASURER" && facts.ownerHousehold.includes(signerUserId)) return "the bucket owner or their household cannot fill the Treasurer seat";
  if (facts.seatedHouseholds.includes(signerUserId)) return "someone in the signer's household already holds a seat on this expense";
  if (seat === "BOARD") return facts.board.includes(signerUserId) ? null : "signer is not a Board member";

  const available = availableSigners(facts, filled, seat);
  if (available.length > 0) return available.includes(signerUserId) ? null : "signer does not hold FINANCE";
  // No FINANCE holder can sign: a non-conflicted Board member fills the seat instead.
  if (!facts.board.includes(signerUserId)) return "signer is not a Board member";
  if (boardSubstitutions(facts, filled) >= maxBoardSubstitutions(facts)) {
    return "no Board substitution left for this line";
  }
  return null;
}

/** A Board member approving a line they are not a bucket approver of, in place of its approvers. */
export function approvesAsStandIn(facts: SignoffFacts, userId: number): boolean {
  return !facts.approvers.includes(userId);
}

/**
 * Why `userId` may not approve the line, or null. The approval is the program approver's
 * sign-off, so it takes a seat's refusals: the reimbursee is known, and the approver is not
 * conflicted, signs no other seat on the line, and has no household member seated on the expense.
 * A reimbursement line is approved only once its submitter has signed. A bucket approver approves; any
 * Board member without a conflict may approve instead, within the Board substitution limit.
 */
export function approvalRefusal(facts: SignoffFacts, filled: FilledSeat[], userId: number): string | null {
  if (facts.reimburseeUnknown) return REIMBURSEE_UNKNOWN;
  if (facts.kind === "reimbursement" && !filled.some((f) => f.seat === "SUBMITTER")) {
    return "The submitter has not confirmed this reimbursement yet; the approval follows";
  }
  if (facts.conflicted.includes(userId)) return "You cannot decide a line on an expense that you or your household submitted or would be reimbursed for";
  if (filled.some((f) => f.signerUserId === userId)) return "You already sign another seat on this line";
  if (facts.seatedHouseholds.includes(userId)) return "Someone in your household already holds a seat on this expense";
  if (!approvesAsStandIn(facts, userId)) return null;
  if (!facts.board.includes(userId)) return "This line item is not in a bucket you approve";
  if (boardSubstitutions(facts, filled) >= maxBoardSubstitutions(facts)) return "No Board substitution left for this line";
  return null;
}
