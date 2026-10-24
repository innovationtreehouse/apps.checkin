import type { Expense, Prisma } from "../generated/prisma/client";
import type { Db } from "../db";
import { getExpenseRuntime } from "../runtime";
import type { BucketApprovers } from "../contract";
import { isEveryday, lineKind, withinEverydayLimits, missingSeats, needsBoardApproval, needsBoardSeat, type FilledSeat, type Seat, type SignoffFacts } from "./signoff";
import { readExpenseSettings } from "../services/settingsService";
import { writeAudit } from "./audit";
import { advanceWorkflowInTx, type Actor } from "./workflow-engine";

type SignoffExpense = Pick<
  Expense,
  | "id"
  | "orgId"
  | "submitterId"
  | "reimburseePersonId"
  | "needsReimbursement"
  | "receiptTotalCents"
  | "boardAuthorization"
  | "everydayWithinLimits"
>;

/** Whether a reimbursement's payee is an org member; true for a card charge or an unknown payee. */
async function reimburseeIsMember(expense: SignoffExpense): Promise<boolean> {
  if (lineKind(expense) !== "reimbursement" || expense.reimburseePersonId === null) return true;
  return getExpenseRuntime().signoff.isOrgMember(expense.reimburseePersonId);
}

/** The submitter, the reimbursee when known, and everyone in either one's household. */
export async function conflictedParties(expense: { submitterId: number; reimburseePersonId: number | null }): Promise<number[]> {
  const parties = expense.reimburseePersonId === null ? [expense.submitterId] : [expense.submitterId, expense.reimburseePersonId];
  return [...new Set([...parties, ...(await getExpenseRuntime().signoff.householdOf(parties))])];
}

/**
 * Household members of everyone seated on the expense, the approvers of its lines and a Board
 * member confirming on a reimbursee's behalf included, minus the seated people themselves: one
 * household holds at most one seat on an expense.
 */
export async function seatedHouseholds(db: Db, expenseId: string): Promise<number[]> {
  const dir = getExpenseRuntime().signoff;
  const [rows, approvals] = await Promise.all([
    db.expenseLineSignoff.findMany({ where: { expenseId }, select: { signerUserId: true } }),
    db.lineItemOwnerApproval.findMany({ where: { expenseId, status: "approved", decidedByUserId: { not: null } }, select: { decidedByUserId: true } }),
  ]);
  const signers = [...new Set([...rows.map((r) => r.signerUserId), ...approvals.map((a) => a.decidedByUserId!)])];
  const mates = await Promise.all(signers.map(async (s) => (await dir.householdOf([s])).filter((id) => id !== s)));
  return [...new Set(mates.flat())];
}

/**
 * The expense's frozen Everyday amount check. An expense frozen at intake keeps its result; one
 * with none freezes now against the current limits, and a concurrent freeze's result wins.
 */
async function frozenWithinLimits(db: Db, expense: SignoffExpense, unitPricesCents: number[]): Promise<boolean> {
  if (expense.everydayWithinLimits !== null) return expense.everydayWithinLimits;
  const limits = await readExpenseSettings(db, expense.orgId);
  const withinLimits = withinEverydayLimits({ receiptTotalCents: expense.receiptTotalCents, unitPricesCents }, limits);
  await db.expense.updateMany({
    where: { id: expense.id, everydayWithinLimits: null },
    data: { everydayWithinLimits: withinLimits, everydayTotalLimitCents: limits.everydayTotalLimitCents, everydayItemLimitCents: limits.everydayItemLimitCents },
  });
  return (await db.expense.findUniqueOrThrow({ where: { id: expense.id }, select: { everydayWithinLimits: true } })).everydayWithinLimits!;
}

/** Sign-off facts for each line of an expense, read once through the SignoffDirectory port. */
export async function signoffFactsByLine(db: Db, expense: SignoffExpense): Promise<Map<number, SignoffFacts>> {
  const dir = getExpenseRuntime().signoff;
  const [lines, approvals, finance, board, conflicted, seated, isMember, setterRow] = await Promise.all([
    db.expenseLineItem.findMany({ where: { expenseId: expense.id }, select: { id: true, unitPriceCents: true } }),
    db.lineItemOwnerApproval.findMany({ where: { expenseId: expense.id }, select: { lineItemId: true, ownerId: true, status: true, decidedByUserId: true } }),
    dir.financeHolders(),
    dir.boardMembers(),
    conflictedParties(expense),
    seatedHouseholds(db, expense.id),
    reimburseeIsMember(expense),
    db.expenseAuditLog.findFirst({ where: { expenseId: expense.id, action: "reimbursee_set" }, orderBy: { id: "desc" }, select: { userId: true } }),
  ]);
  const bucketOf = new Map(approvals.map((a) => [a.lineItemId, a.ownerId]));
  const approvalOf = new Map(approvals.map((a) => [a.lineItemId, a]));
  const bucketsById = new Map<number, BucketApprovers>();
  const ownerHouseholds = new Map<number, number[]>();
  for (const bucket of new Set(approvals.map((a) => a.ownerId))) {
    if (bucket === null) continue;
    const b = await dir.bucketApprovers(bucket);
    bucketsById.set(bucket, b);
    if (b.owner !== null) ownerHouseholds.set(bucket, [...new Set([b.owner, ...(await dir.householdOf([b.owner]))])]);
  }
  const kind = lineKind(expense);
  const withinLimits = await frozenWithinLimits(db, expense, lines.map((l) => l.unitPriceCents));
  const everyday = isEveryday({ withinLimits });
  return new Map(
    lines.map((l) => {
      const bucket = bucketOf.get(l.id) ?? null;
      const b = bucket === null ? undefined : bucketsById.get(bucket);
      const approved = approvalOf.get(l.id)?.status === "approved";
      const facts: SignoffFacts = {
        kind,
        submitterId: expense.submitterId,
        reimburseeId: expense.reimburseePersonId,
        approvers: b?.approvers ?? [],
        orgLevel: b?.orgLevel ?? false,
        reimburseeIsMember: isMember,
        finance,
        board,
        conflicted,
        ownerHousehold: bucket === null ? [] : (ownerHouseholds.get(bucket) ?? []),
        reimburseeSetter: setterRow?.userId ?? (expense.reimburseePersonId === null ? null : expense.submitterId),
        seatedHouseholds: seated,
        boardSeat: needsBoardSeat(kind, everyday, b !== undefined && !b.orgLevel, expense.boardAuthorization),
        approved,
        approver: approved ? (approvalOf.get(l.id)?.decidedByUserId ?? null) : null,
      };
      return [l.id, facts];
    }),
  );
}

export async function filledSeatsByLine(db: Db, expenseId: string): Promise<Map<number, FilledSeat[]>> {
  const rows = await db.expenseLineSignoff.findMany({ where: { expenseId }, select: { lineItemId: true, seat: true, signerUserId: true } });
  const out = new Map<number, FilledSeat[]>();
  for (const r of rows) out.set(r.lineItemId, [...(out.get(r.lineItemId) ?? []), { seat: r.seat as Seat, signerUserId: r.signerUserId }]);
  return out;
}

export type LineHold = Seat | "BOARD_APPROVAL";

/** Whether the expense is held for the Board's approval, against the org's current Board-review total. */
export async function boardApprovalNeeded(db: Db, expense: Pick<SignoffExpense, "orgId" | "receiptTotalCents" | "boardAuthorization">): Promise<boolean> {
  const { boardReviewTotalCents } = await readExpenseSettings(db, expense.orgId);
  return needsBoardApproval(expense.receiptTotalCents, boardReviewTotalCents, expense.boardAuthorization);
}

/** What still holds a line: its unfilled seats, then the Board's approval when the expense needs it. */
export function lineHolds(approvalNeeded: boolean, facts: SignoffFacts, filled: FilledSeat[]): LineHold[] {
  return [...missingSeats(facts, filled), ...(approvalNeeded ? (["BOARD_APPROVAL"] as const) : [])];
}

/**
 * Lines still missing a seat or the Board's approval. A held line keeps the whole expense out of
 * the QB outbox.
 */
export async function unsignedLines(db: Db, expense: SignoffExpense): Promise<Map<number, LineHold[]>> {
  const [facts, filled, approval] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expense.id), boardApprovalNeeded(db, expense)]);
  const out = new Map<number, LineHold[]>();
  for (const [lineId, f] of facts) {
    const missing = lineHolds(approval, f, filled.get(lineId) ?? []);
    if (missing.length > 0) out.set(lineId, missing);
  }
  return out;
}

/**
 * Locks the expense row for the rest of the transaction. Every path that reads sign-off facts
 * and then writes a seat, a reimbursee or a bucket takes it first, so those writes serialize.
 */
export async function lockExpense(tx: Prisma.TransactionClient, expenseId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId} FOR UPDATE`;
}

/** A step on a line, in the order of its signatures: the submitter seat, the approval, the Treasurer seat. */
export type ClearedStep = "SUBMITTER" | "APPROVAL" | "TREASURER";

/** Open states past owner approval; an expense in one returns to owner approval when an approval reopens. */
const PAST_OWNER_APPROVAL = new Set(["capital_review", "set_depreciation_cycle", "qb_pending", "qb_on_hold", "qb_error"]);

/**
 * Clears `from` and every later step on the given lines (every line when `lineItemIds` is null):
 * deletes the seats, reopens an approved approval to pending, and clears those lines' catalog
 * snapshots, so each step is given again in order. Each cleared seat is audited as
 * `signoff_voided` and each reopened approval as `approval_cleared`, naming `reason`. An expense
 * past owner approval whose approval reopens returns to owner approval.
 */
export async function clearFrom(
  tx: Prisma.TransactionClient,
  actor: Actor,
  expenseId: string,
  lineItemIds: number[] | null,
  from: ClearedStep,
  reason: string,
): Promise<void> {
  const lines = lineItemIds ? { lineItemId: { in: lineItemIds } } : {};
  const seats: Seat[] = from === "SUBMITTER" ? ["SUBMITTER", "TREASURER", "BOARD"] : ["TREASURER", "BOARD"];
  const voided = await tx.expenseLineSignoff.findMany({ where: { expenseId, seat: { in: seats }, ...lines }, orderBy: { id: "asc" } });
  const reopened = from === "TREASURER" ? [] : await tx.lineItemOwnerApproval.findMany({ where: { expenseId, status: "approved", ...lines }, orderBy: { id: "asc" } });
  if (voided.length === 0 && reopened.length === 0) return;

  await tx.expenseLineSignoff.deleteMany({ where: { id: { in: voided.map((v) => v.id) } } });
  await tx.lineItemOwnerApproval.updateMany({
    where: { id: { in: reopened.map((a) => a.id) } },
    data: { status: "pending", decidedAt: null, decidedByUserId: null, notes: null },
  });
  await tx.expenseLineItem.updateMany({
    where: { id: { in: [...new Set([...voided, ...reopened].map((v) => v.lineItemId))] } },
    data: { signedGtin13: null, signedCategory: null, signedSubcategory: null },
  });
  for (const a of reopened) {
    await writeAudit(tx, actor, {
      expenseId,
      action: "approval_cleared",
      lineItemId: a.lineItemId,
      fieldChanged: "status",
      valueBefore: "approved",
      valueAfter: "pending",
      notes: `approver ${a.decidedByUserId ?? "none"}: ${reason}`,
    });
  }
  for (const v of voided) {
    await writeAudit(tx, actor, {
      expenseId,
      action: "signoff_voided",
      lineItemId: v.lineItemId,
      fieldChanged: "seat",
      valueBefore: v.seat,
      notes: `signer ${v.signerUserId}: ${reason}`,
    });
  }

  const { state } = (await tx.expense.findUnique({ where: { id: expenseId }, select: { state: true } }))!;
  if (reopened.length > 0 && PAST_OWNER_APPROVAL.has(state)) {
    await advanceWorkflowInTx(tx, { expenseId, currentState: state, event: { type: "APPROVAL_REOPENED" }, actor, action: "state_transition", auditNotes: reason });
  }
}
