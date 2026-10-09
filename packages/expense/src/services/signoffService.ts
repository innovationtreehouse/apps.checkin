// Sign-off seats on reimbursement and card-charge lines (F2 / F2-COI). The signer is always the
// principal; a line with an unfilled seat holds its expense out of the QB outbox.
import { db, isUniqueConstraintError } from "../db";
import type { ExpensePrincipal, SetReimbursee } from "../contract";
import { assertOrg, getExpenseRuntime, getOrg } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { drainExpense } from "../lib/financial-flow";
import { conflictedParties, filledSeatsByLine, signoffFactsByLine, unsignedLines } from "../lib/signoff-facts";
import { CLOSED_STATES, blockedSeats, missingSeats, reimburseeUnknown, signoffRefusal, type Seat } from "../lib/signoff";
import { raiseFlag } from "./flagService";
import { ServiceError } from "./serviceError";

export async function signLine(principal: ExpensePrincipal, lineItemId: number, seat: Seat): Promise<void> {
  const actor = actorOf(principal);
  const line = await db.expenseLineItem.findFirst({
    where: { id: lineItemId, expense: { orgId: getOrg().id } },
    include: { expense: true },
  });
  if (!line) throw new ServiceError(404, "Line item not found");
  const { expense } = line;
  if (expense.backfill) throw new ServiceError(400, "A backfilled expense is already booked; it takes no sign-off");
  if (CLOSED_STATES.has(expense.state)) throw new ServiceError(400, `Expense is ${expense.state}`);
  if (reimburseeUnknown(expense)) throw new ServiceError(409, "The reimbursee is unknown; FINANCE sets it before anyone signs");

  const facts = (await signoffFactsByLine(db, expense)).get(lineItemId)!;
  const filled = (await filledSeatsByLine(db, expense.id)).get(lineItemId) ?? [];
  const refusal = signoffRefusal(facts, filled, seat, actor.userId);
  if (refusal) throw new ServiceError(403, refusal);

  try {
    await db.$transaction(async (tx) => {
      await tx.expenseLineSignoff.create({
        data: { expenseId: expense.id, lineItemId, seat, signerUserId: actor.userId, signerUsername: actor.username },
      });
      await writeAudit(tx, actor, { expenseId: expense.id, action: "signoff", lineItemId, fieldChanged: "seat", valueAfter: seat });
    });
  } catch (err) {
    // The seat or the signer was taken by a concurrent sign-off.
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "Seat already filled or signer already seated");
    throw err;
  }

  const nowFilled = [...filled, { seat, signerUserId: actor.userId }];
  if (seat === "TREASURER" && !facts.finance.includes(actor.userId)) {
    await raiseFlag(expense.id, "COI", "no FINANCE holder could sign; a Board member took the Treasurer seat");
  }
  if (blockedSeats(facts, nowFilled).length > 0) {
    await raiseFlag(expense.id, "COI", "a card charge needs a second Board substitution; held");
  }
  if (expense.state === "qb_pending" && (await unsignedLines(db, expense)).size === 0) {
    await drainExpense(expense.orgId, expense.id);
  }
}

/**
 * Sets the Person owed a reimbursement, clears REIMBURSEE_UNKNOWN, and voids every non-submitter
 * sign-off by someone the new reimbursee conflicts, so that seat is signed again.
 */
export const setReimbursee: SetReimbursee = async (orgId, expenseId, personId, principal) => {
  assertOrg(orgId);
  const actor = actorOf(principal);
  if (!principal.isFinance) throw new ServiceError(403, "Only FINANCE sets the reimbursee");
  if (!Number.isInteger(personId) || personId <= 0) throw new ServiceError(400, "personId must be a positive integer");

  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  if (!expense.needsReimbursement) throw new ServiceError(400, "Expense is not a reimbursement");
  if (expense.backfill) throw new ServiceError(400, "A backfilled expense is already booked; it takes no reimbursee");
  if (CLOSED_STATES.has(expense.state)) throw new ServiceError(400, `Expense is ${expense.state}`);
  const dir = getExpenseRuntime().signoff;
  if (!(await dir.personExists(personId))) throw new ServiceError(404, "Person not found");
  const ownHousehold = [personId, ...(await dir.householdOf([personId]))];
  if (ownHousehold.includes(actor.userId)) throw new ServiceError(403, "You cannot name yourself or your household as reimbursee");

  const conflicted = await conflictedParties({ submitterId: expense.submitterId, reimburseePersonId: personId });
  await db.$transaction(async (tx) => {
    await tx.expense.update({ where: { id: expenseId }, data: { reimburseePersonId: personId } });
    await writeAudit(tx, actor, {
      expenseId,
      action: "reimbursee_set",
      fieldChanged: "reimburseePersonId",
      valueBefore: expense.reimburseePersonId === null ? null : String(expense.reimburseePersonId),
      valueAfter: String(personId),
    });
    const voided = await tx.expenseLineSignoff.findMany({
      where: { expenseId, seat: { not: "SUBMITTER" }, signerUserId: { in: conflicted } },
    });
    await tx.expenseLineSignoff.deleteMany({ where: { id: { in: voided.map((v) => v.id) } } });
    for (const v of voided) {
      await writeAudit(tx, actor, {
        expenseId,
        action: "signoff_voided",
        lineItemId: v.lineItemId,
        fieldChanged: "seat",
        valueBefore: v.seat,
        notes: `signer ${v.signerUserId} conflicts with the reimbursee`,
      });
    }
    await tx.expenseFlag.updateMany({
      where: { expenseId, kind: "REIMBURSEE_UNKNOWN", checkedOffAt: null },
      data: { checkedOffAt: new Date(), checkedOffByUserId: actor.userId, checkedOffByUsername: actor.username, notes: "reimbursee set" },
    });
  });

  if (expense.state === "qb_pending") await drainExpense(orgId, expenseId);
};

/** Per line: the seats filled, still missing, and blocked (held until finance or the board acts). */
export async function signoffStatus(expenseId: string) {
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId: getOrg().id } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  const [facts, filled] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expenseId)]);
  return [...facts].map(([lineItemId, f]) => {
    const seats = filled.get(lineItemId) ?? [];
    return { lineItemId, filled: seats, missing: missingSeats(f, seats), blocked: blockedSeats(f, seats) };
  });
}
