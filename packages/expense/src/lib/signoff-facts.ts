import type { Expense } from "../generated/prisma/client";
import type { Db } from "../db";
import { getExpenseRuntime } from "../runtime";
import type { BucketApprovers } from "../contract";
import { readExpenseSettings } from "../services/settingsService";
import { lineKind, missingSeats, type FilledSeat, type Seat, type SignoffFacts } from "./signoff";

type SignoffExpense = Pick<
  Expense,
  "id" | "orgId" | "submitterId" | "reimburseePersonId" | "needsReimbursement" | "receiptTotalCents" | "noteInLieuOfReceipt"
>;

/** Sign-off facts for each line of an expense, read once through the SignoffDirectory port. */
export async function signoffFactsByLine(db: Db, expense: SignoffExpense): Promise<Map<number, SignoffFacts>> {
  const dir = getExpenseRuntime().signoff;
  const parties = expense.reimburseePersonId === null ? [expense.submitterId] : [expense.submitterId, expense.reimburseePersonId];
  const [lines, approvals, finance, board, households, purchaserIsMember, settings] = await Promise.all([
    db.expenseLineItem.findMany({ where: { expenseId: expense.id }, select: { id: true } }),
    db.lineItemOwnerApproval.findMany({ where: { expenseId: expense.id }, select: { lineItemId: true, ownerId: true } }),
    dir.financeHolders(),
    dir.boardMembers(),
    dir.householdOf(parties),
    dir.isOrgMember(expense.submitterId),
    readExpenseSettings(db, expense.orgId),
  ]);
  const conflicted = [...new Set([...parties, ...households])];
  const bucketOf = new Map(approvals.map((a) => [a.lineItemId, a.ownerId]));
  const bucketsById = new Map<number, BucketApprovers>();
  for (const bucket of new Set(approvals.map((a) => a.ownerId))) {
    if (bucket !== null) bucketsById.set(bucket, await dir.bucketApprovers(bucket));
  }
  const kind = lineKind(expense);
  return new Map(
    lines.map((l) => {
      const bucket = bucketOf.get(l.id) ?? null;
      const b = bucket === null ? undefined : bucketsById.get(bucket);
      const facts: SignoffFacts = {
        kind,
        submitterId: expense.submitterId,
        approvers: b?.approvers ?? [],
        orgLevel: b?.orgLevel ?? false,
        totalCents: expense.receiptTotalCents,
        noteInLieuOfReceipt: expense.noteInLieuOfReceipt,
        noteInLieuLimitCents: settings.noteInLieuLimitCents,
        purchaserIsMember,
        finance,
        board,
        conflicted,
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

/** Lines still missing a seat. A held line keeps the whole expense out of the QB outbox. */
export async function unsignedLines(db: Db, expense: SignoffExpense): Promise<Map<number, Seat[]>> {
  const [facts, filled] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expense.id)]);
  const out = new Map<number, Seat[]>();
  for (const [lineId, f] of facts) {
    const missing = missingSeats(f, filled.get(lineId) ?? []);
    if (missing.length > 0) out.set(lineId, missing);
  }
  return out;
}
