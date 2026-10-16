import type { Expense, Prisma } from "../generated/prisma/client";
import type { Db } from "../db";
import { getExpenseRuntime } from "../runtime";
import type { BucketApprovers } from "../contract";
import { isEveryday, lineKind, missingSeats, needsBoardAuthorization, type FilledSeat, type Seat, type SignoffFacts } from "./signoff";
import { readExpenseSettings } from "../services/settingsService";
import { writeAudit } from "./audit";
import type { Actor } from "./workflow-engine";

type SignoffExpense = Pick<
  Expense,
  | "id"
  | "orgId"
  | "submitterId"
  | "reimburseePersonId"
  | "needsReimbursement"
  | "receiptTotalCents"
  | "singleSource"
  | "financeNotEveryday"
  | "boardAuthorization"
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
 * Household members of everyone seated on the expense outside the submitter seat, minus the
 * seated people themselves: one household holds at most one seat on an expense.
 */
export async function seatedHouseholds(db: Db, expenseId: string): Promise<number[]> {
  const dir = getExpenseRuntime().signoff;
  const rows = await db.expenseLineSignoff.findMany({ where: { expenseId, seat: { not: "SUBMITTER" } }, select: { signerUserId: true } });
  const signers = [...new Set(rows.map((r) => r.signerUserId))];
  const mates = await Promise.all(signers.map(async (s) => (await dir.householdOf([s])).filter((id) => id !== s)));
  return [...new Set(mates.flat())];
}

/** Sign-off facts for each line of an expense, read once through the SignoffDirectory port. */
export async function signoffFactsByLine(db: Db, expense: SignoffExpense): Promise<Map<number, SignoffFacts>> {
  const dir = getExpenseRuntime().signoff;
  const [lines, approvals, finance, board, conflicted, seated, isMember, setterRow, settings] = await Promise.all([
    db.expenseLineItem.findMany({ where: { expenseId: expense.id }, select: { id: true, unitPriceCents: true } }),
    db.lineItemOwnerApproval.findMany({ where: { expenseId: expense.id }, select: { lineItemId: true, ownerId: true } }),
    dir.financeHolders(),
    dir.boardMembers(),
    conflictedParties(expense),
    seatedHouseholds(db, expense.id),
    reimburseeIsMember(expense),
    db.expenseAuditLog.findFirst({ where: { expenseId: expense.id, action: "reimbursee_set" }, orderBy: { id: "desc" }, select: { userId: true } }),
    readExpenseSettings(db, expense.orgId),
  ]);
  const bucketOf = new Map(approvals.map((a) => [a.lineItemId, a.ownerId]));
  const bucketsById = new Map<number, BucketApprovers>();
  const leaderHouseholds = new Map<number, number[]>();
  for (const bucket of new Set(approvals.map((a) => a.ownerId))) {
    if (bucket === null) continue;
    const b = await dir.bucketApprovers(bucket);
    bucketsById.set(bucket, b);
    if (b.leader !== null) leaderHouseholds.set(bucket, [...new Set([b.leader, ...(await dir.householdOf([b.leader]))])]);
  }
  const kind = lineKind(expense);
  const everyday = isEveryday({ ...expense, unitPricesCents: lines.map((l) => l.unitPriceCents) }, settings);
  const authorizationNeeded = needsBoardAuthorization(kind, everyday, expense.boardAuthorization);
  return new Map(
    lines.map((l) => {
      const bucket = bucketOf.get(l.id) ?? null;
      const b = bucket === null ? undefined : bucketsById.get(bucket);
      const facts: SignoffFacts = {
        kind,
        submitterId: expense.submitterId,
        approvers: b?.approvers ?? [],
        orgLevel: b?.orgLevel ?? false,
        reimburseeIsMember: isMember,
        finance,
        board,
        conflicted,
        leaderHousehold: bucket === null ? [] : (leaderHouseholds.get(bucket) ?? []),
        reimburseeSetter: setterRow?.userId ?? null,
        seatedHouseholds: seated,
        needsBoardAuthorization: authorizationNeeded,
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

export type LineHold = Seat | "BOARD_AUTHORIZATION";

/**
 * Lines still missing a seat or the Board authorization. A held line keeps the whole expense out
 * of the QB outbox.
 */
export async function unsignedLines(db: Db, expense: SignoffExpense): Promise<Map<number, LineHold[]>> {
  const [facts, filled] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expense.id)]);
  const out = new Map<number, LineHold[]>();
  for (const [lineId, f] of facts) {
    const missing: LineHold[] = [...missingSeats(f, filled.get(lineId) ?? []), ...(f.needsBoardAuthorization ? (["BOARD_AUTHORIZATION"] as const) : [])];
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

/**
 * Deletes the non-submitter sign-offs on the given lines (every line when `lineItemIds` is
 * null), clears those lines' catalog snapshots, and audits each as `signoff_voided`, so those
 * seats are signed again and the re-signed line takes a fresh snapshot.
 */
export async function voidSignoffs(
  tx: Prisma.TransactionClient,
  actor: Actor,
  expenseId: string,
  lineItemIds: number[] | null,
  reason: string,
): Promise<void> {
  const where = { expenseId, seat: { not: "SUBMITTER" }, ...(lineItemIds ? { lineItemId: { in: lineItemIds } } : {}) };
  const voided = await tx.expenseLineSignoff.findMany({ where });
  if (voided.length === 0) return;
  await tx.expenseLineSignoff.deleteMany({ where: { id: { in: voided.map((v) => v.id) } } });
  await tx.expenseLineItem.updateMany({
    where: { id: { in: [...new Set(voided.map((v) => v.lineItemId))] } },
    data: { signedGtin13: null, signedCategory: null, signedSubcategory: null },
  });
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
}
