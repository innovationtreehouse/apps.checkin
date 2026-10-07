// Sign-off seats on money leaving the org (Financial Policy F2 / F2-COI). Pure rules over facts
// the service gathers through the SignoffDirectory port.

export const SEATS = ["SUBMITTER", "PROGRAM_APPROVER", "TREASURER"] as const;
export type Seat = (typeof SEATS)[number];

/** A reimbursement becomes a Bill; every other line is a card charge (a Purchase). */
export type LineKind = "reimbursement" | "card_charge";

export interface SignoffFacts {
  kind: LineKind;
  submitterId: number;
  /** The line's bucket approvers (program leader + treasurers); empty for an org-level bucket. */
  approvers: number[];
  orgLevel: boolean;
  /** The expense's receipt total. */
  totalCents: number;
  noteInLieuOfReceipt: boolean;
  /** The org's note-in-lieu limit (ExpenseOrgSettings). */
  noteInLieuLimitCents: number;
  purchaserIsMember: boolean;
  finance: number[];
  board: number[];
  /** The submitter, the reimbursee, and their households. */
  conflicted: number[];
}

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

/**
 * F2 exceptions: a Board member, not a program approver, fills the program-approver seat for an
 * org-level bucket, a note in lieu of a receipt at or over the org's limit, or a non-member purchaser.
 * The Treasurer seat stays.
 */
export function boardFillsProgramSeat(facts: SignoffFacts): boolean {
  if (facts.orgLevel || !facts.purchaserIsMember) return true;
  return facts.noteInLieuOfReceipt && facts.totalCents >= facts.noteInLieuLimitCents;
}

/** Who the seat belongs to before any Board substitution. */
function eligible(facts: SignoffFacts, seat: Exclude<Seat, "SUBMITTER">): number[] {
  if (seat === "TREASURER") return facts.finance;
  return boardFillsProgramSeat(facts) ? [] : facts.approvers;
}

/** Eligible people who can still sign the seat: not conflicted and not in another seat on the line. */
export function availableSigners(facts: SignoffFacts, filled: FilledSeat[], seat: Exclude<Seat, "SUBMITTER">): number[] {
  const blocked = new Set([...facts.conflicted, ...filled.filter((f) => f.seat !== seat).map((f) => f.signerUserId)]);
  return eligible(facts, seat).filter((id) => !blocked.has(id));
}

/** Seats filled by a Board member standing in for a seat nobody eligible could fill. */
function boardSubstitutions(facts: SignoffFacts, filled: FilledSeat[]): number {
  return filled.filter((f) => f.seat !== "SUBMITTER" && !eligible(facts, f.seat).includes(f.signerUserId)).length;
}

/** Policy allows two Board substitutions on a reimbursement, one on a card charge. */
function maxBoardSubstitutions(facts: SignoffFacts): number {
  return facts.kind === "card_charge" ? 1 : 2;
}

export function missingSeats(facts: SignoffFacts, filled: FilledSeat[]): Seat[] {
  const done = new Set(filled.map((f) => f.seat));
  return SEATS.filter((s) => !done.has(s));
}

/**
 * Seats nobody can fill: no eligible signer is available and the Board substitutions are used up.
 * A card charge that needs a second substitution lands here; it is held and flagged to the board.
 */
export function blockedSeats(facts: SignoffFacts, filled: FilledSeat[]): Seat[] {
  const open = missingSeats(facts, filled).filter((s): s is Exclude<Seat, "SUBMITTER"> => s !== "SUBMITTER");
  const needBoard = open.filter((s) => availableSigners(facts, filled, s).length === 0);
  const room = maxBoardSubstitutions(facts) - boardSubstitutions(facts, filled);
  return needBoard.slice(Math.max(0, room));
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
  if (facts.conflicted.includes(signerUserId)) return "signer is the submitter, the reimbursee, or in their household";

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
