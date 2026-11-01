// Sign-off seats on money leaving the org (Financial Policy Arts. IX and XII). Pure rules over facts
// the service gathers through the SignoffDirectory port. The program approver signs a line by
// approving it, so the approval is not a seat.
import type { Prisma } from "../generated/prisma/client";

/** The seats in the order they are signed; the line's approval comes between the first two. */
export const SEATS = ["SUBMITTER", "TREASURER", "BOARD"] as const;
export type Seat = (typeof SEATS)[number];

/** A reimbursement becomes a Bill; every other line is a card charge (a Purchase). */
export type LineKind = "reimbursement" | "card_charge";

export interface SignoffFacts {
  kind: LineKind;
  submitterId: number;
  /** The person reimbursed, who gives the submitter's signature; null on a card charge or while unknown. */
  reimburseeId: number | null;
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
  /** FINANCE made the line's bucket final while conflicted on the expense. */
  conflictedFinal: boolean;
  /** The line's approval is `approved`: the program approver's sign-off. */
  approved: boolean;
  /** Who approved the line; null while it is not approved, or for a line approved at intake. */
  approver: number | null;
  /** Everyone who signs a step anywhere on the expense: the approvers of its approved lines and its Treasurer and Board signers. */
  expenseSigners: StepSigner[];
}

/** The steps in order: the submitter seat, the line's approval (the bucket level), the Treasurer, the Board. */
export type Step = "APPROVAL" | Seat;

export interface StepSigner {
  step: Step;
  userId: number;
}

/** Whoever signs a step other than `step` on the expense: one person signs at most one step of it. */
function otherStepSigners(facts: SignoffFacts, step: Step): Set<number> {
  return new Set(facts.expenseSigners.filter((s) => s.step !== step).map((s) => s.userId));
}

export const CLOSED_STATES = new Set(["qb_complete", "qb_skipped", "rejected"]);

/** A pending line, or one finance moved to another bucket, which waits for that bucket's approver. */
export const APPROVABLE_STATUSES = new Set(["pending", "finance_assigned"]);

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
 * without one. It is the Board's step, so whoever signs an earlier step on the expense, or shares
 * a household with anyone seated on it, does not record it. The recorder then counts as the
 * Board step's signer.
 */
export function boardAuthorizationRefusal(factsByLine: SignoffFacts[], userId: number): string | null {
  if (factsByLine.length === 0) return "the expense has no lines";
  const blocked = new Set(factsByLine.flatMap((f) => f.conflicted));
  if (blocked.has(userId)) return "someone conflicted on the charge cannot record the Board authorization";
  for (const id of [...otherStepSigners(factsByLine[0], "BOARD"), ...factsByLine[0].seatedHouseholds]) blocked.add(id);
  if (blocked.has(userId)) return "someone who signs an earlier step on this expense, or shares a household with anyone seated on it, cannot record the Board authorization";
  const { finance, board } = factsByLine[0];
  if (finance.some((id) => !blocked.has(id))) return finance.includes(userId) ? null : "signer does not hold FINANCE";
  return board.includes(userId) ? null : "signer is not a Board member";
}

/**
 * The line takes the Board seat: a non-Everyday card charge without written Board authorization,
 * a reimbursement owed to a non-member, or a line whose bucket a conflicted FINANCE holder made
 * final. The last two take a Board signature after the line's approval, which no authorization replaces.
 */
export function takesBoardSeat(facts: SignoffFacts): boolean {
  return facts.boardSeat || facts.conflictedFinal || (facts.kind === "reimbursement" && !facts.reimburseeIsMember);
}

/** Who the seat belongs to; a Board member stands in for a Treasurer only when none of them can sign. */
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
 * another seat on it, not signing another step anywhere on the expense, and not in the household
 * of someone seated on the expense. The Treasurer seat also excludes the reimbursee's setter and
 * the bucket owner's household.
 */
export function availableSigners(facts: SignoffFacts, filled: FilledSeat[], seat: Exclude<Seat, "SUBMITTER">): number[] {
  return eligible(facts, seat).filter(canSign(facts, filled, seat));
}

/** Whether a person passes the seat's conflict, step and household rules, whatever their role. */
function canSign(facts: SignoffFacts, filled: FilledSeat[], seat: Exclude<Seat, "SUBMITTER">): (id: number) => boolean {
  const blocked = new Set([...facts.conflicted, ...facts.seatedHouseholds, ...onLine(facts, filled, seat), ...otherStepSigners(facts, seat)]);
  if (seat === "TREASURER") for (const id of treasurerConflicted(facts)) blocked.add(id);
  return (id) => !blocked.has(id);
}

/** The line's unfilled seats. A card charge takes no submitter seat; the Board seat counts only on a line that takes it. */
export function missingSeats(facts: SignoffFacts, filled: FilledSeat[]): Seat[] {
  const done = new Set(filled.map((f) => f.seat));
  return SEATS.filter((s) => !done.has(s) && (s !== "SUBMITTER" || facts.kind === "reimbursement") && (s !== "BOARD" || takesBoardSeat(facts)));
}

/**
 * Seats nobody independent is left to sign: no eligible signer and no Board member who could
 * stand in under the same conflict, step and household rules. Such a line is held, and shows in
 * the finance queue as a held signer.
 */
export function blockedSeats(facts: SignoffFacts, filled: FilledSeat[]): Seat[] {
  return missingSeats(facts, filled).filter(
    (s): s is Exclude<Seat, "SUBMITTER"> =>
      s !== "SUBMITTER" && availableSigners(facts, filled, s).length === 0 && !facts.board.some(canSign(facts, filled, s)),
  );
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

/**
 * Why `signerUserId` may not fill the submitter seat, or null. The person reimbursed signs it;
 * otherwise a Board member without a conflict signs on their behalf, and takes no other step on
 * the expense. Either way nobody in the signer's household holds another seat on it.
 */
export function submitterSeatRefusal(facts: SignoffFacts, filled: FilledSeat[], signerUserId: number): string | null {
  if (filled.some((f) => f.seat === "SUBMITTER")) return "seat SUBMITTER is already filled";
  if (filled.some((f) => f.signerUserId === signerUserId)) return "signer already fills another seat on this line";
  if (facts.kind === "card_charge") return "a card charge takes no submitter seat";
  if (signerUserId !== facts.reimburseeId) {
    if (!facts.board.includes(signerUserId)) return "only the person reimbursed, or a Board member on their behalf, fills the submitter seat";
    if (facts.conflicted.includes(signerUserId)) return "signer is the submitter, the reimbursee, or in their household";
    if (otherStepSigners(facts, "SUBMITTER").has(signerUserId)) return "signer already signs another step on this expense";
  }
  if (facts.seatedHouseholds.includes(signerUserId)) return "someone in the signer's household already signs off on this expense";
  return orderRefusal(facts, filled, "SUBMITTER");
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

  if (seat === "SUBMITTER") return submitterSeatRefusal(facts, filled, signerUserId);
  if (seat === "BOARD" && !takesBoardSeat(facts)) return "this line takes no Board seat";
  const outOfOrder = orderRefusal(facts, filled, seat);
  if (outOfOrder) return outOfOrder;
  if (signerUserId === facts.approver) return "whoever approved the line does not sign another seat on it";
  if (facts.conflicted.includes(signerUserId)) return "signer is the submitter, the reimbursee, or in their household";
  if (otherStepSigners(facts, seat).has(signerUserId)) return "signer already signs another step on this expense";
  if (seat === "TREASURER" && signerUserId === facts.reimburseeSetter) return "whoever set the reimbursee cannot fill the Treasurer seat";
  if (seat === "TREASURER" && facts.ownerHousehold.includes(signerUserId)) return "the bucket owner or their household cannot fill the Treasurer seat";
  if (facts.seatedHouseholds.includes(signerUserId)) return "someone in the signer's household already signs off on this expense";
  if (seat === "BOARD") return facts.board.includes(signerUserId) ? null : "signer is not a Board member";

  const available = availableSigners(facts, filled, seat);
  if (available.length > 0) return available.includes(signerUserId) ? null : "signer does not hold FINANCE";
  // No FINANCE holder can sign: a non-conflicted Board member fills the seat instead.
  return facts.board.includes(signerUserId) ? null : "signer is not a Board member";
}

/** A Board member approving a line they are not a bucket approver of, in place of its approvers. */
export function approvesAsStandIn(facts: SignoffFacts, userId: number): boolean {
  return !facts.approvers.includes(userId);
}

/**
 * Why `userId` may not approve the line, or null. The approval is the program approver's
 * sign-off, so it takes a seat's refusals: the reimbursee is known, and the approver is not
 * conflicted, signs no Treasurer or Board seat on the expense, and has no household member seated on it.
 * A reimbursement line is approved only once its submitter has signed. A bucket approver approves; any
 * Board member without a conflict may approve instead, holding FINANCE or not.
 */
export function approvalRefusal(facts: SignoffFacts, filled: FilledSeat[], userId: number): string | null {
  if (facts.reimburseeUnknown) return REIMBURSEE_UNKNOWN;
  if (facts.kind === "reimbursement" && !filled.some((f) => f.seat === "SUBMITTER")) {
    return "The submitter has not confirmed this reimbursement yet; the approval follows";
  }
  if (facts.conflicted.includes(userId)) return "You cannot decide a line on an expense that you or your household submitted or would be reimbursed for";
  if (filled.some((f) => f.signerUserId === userId)) return "You already sign another seat on this line";
  if (otherStepSigners(facts, "APPROVAL").has(userId)) return "You already sign a later step on this expense";
  if (facts.seatedHouseholds.includes(userId)) return "Someone in your household already signs off on this expense";
  if (!approvesAsStandIn(facts, userId)) return null;
  return facts.board.includes(userId) ? null : "This line item is not in a bucket you approve";
}

/**
 * Expenses with a line `me` may approve, as a query over the expense rows: every check of
 * approvalRefusal and the approve act that reads only the expense and `me`. It keeps each expense
 * with a line they allow, and may keep more: whether a Board stand-in's approval is the line's main
 * act needs the other approvers' households, so lineActions decides. `household` is everyone in
 * `me`'s household, merged-away people included; `buckets` are the buckets `me` approves.
 */
export function approvableByCallerWhere(me: number, household: number[], buckets: number[], isBoard: boolean): Prisma.ExpenseWhereInput {
  const mine = [...new Set([me, ...household])];
  const mates = mine.filter((id) => id !== me);
  const waiting: Prisma.LineItemOwnerApprovalWhereInput = { status: { in: [...APPROVABLE_STATUSES] }, ...(isBoard ? {} : { ownerId: { in: buckets } }) };
  return {
    backfill: false,
    state: "owner_approval",
    // Not conflicted: neither party is `me` or in their household; a reimbursee is named.
    submitterId: { notIn: mine },
    AND: [
      { OR: [{ needsReimbursement: false, reimburseePersonId: null }, { reimburseePersonId: { notIn: mine } }] },
      // A reimbursement line is approved once its submitter seat is signed.
      { OR: [{ needsReimbursement: false, approvals: { some: waiting } }, { needsReimbursement: true, approvals: { some: { ...waiting, lineItem: { signoffs: { some: { seat: "SUBMITTER" } } } } } }] },
      // `me` signs no seat or Board step on it, and nobody in their household signs any step.
      { lineItems: { none: { signoffs: { some: { signerUserId: { in: mine } } } } } },
      { approvals: { none: { status: "approved", decidedByUserId: { in: mates } } } },
      { OR: [{ boardAuthorizedByUserId: null }, { boardAuthorizedByUserId: { notIn: mine } }] },
    ],
  };
}
