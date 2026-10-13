// Sign-off seats on reimbursement and card-charge lines (F2 / F2-COI). The signer is always the
// principal; a line with an unfilled seat holds its expense out of the QB outbox.
import { db, isUniqueConstraintError } from "../db";
import type { ExpensePrincipal, SetReimbursee } from "../contract";
import { assertOrg, getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { drainExpense } from "../lib/financial-flow";
import { filledSeatsByLine, lockExpense, signoffFactsByLine, unsignedLines, voidSignoffs } from "../lib/signoff-facts";
import { CLOSED_STATES, blockedSeats, missingSeats, reimburseeUnknown, signoffRefusal, type Seat } from "../lib/signoff";
import { raiseFlag } from "./flagService";
import { ServiceError } from "./serviceError";

export async function signLine(principal: ExpensePrincipal, lineItemId: number, seat: Seat): Promise<void> {
  const actor = actorOf(principal);
  const line = await db.expenseLineItem.findFirst({
    where: { id: lineItemId, expense: { orgId: await getOrgId() } },
    select: { expenseId: true },
  });
  if (!line) throw new ServiceError(404, "Line item not found");

  // Facts are read under the expense row lock, so a reimbursee or bucket change cannot commit
  // between the eligibility check and the insert.
  const signed = await db
    .$transaction(async (tx) => {
      await lockExpense(tx, line.expenseId);
      const expense = (await tx.expense.findUnique({ where: { id: line.expenseId } }))!;
      if (expense.backfill) throw new ServiceError(400, "A backfilled expense is already booked; it takes no sign-off");
      if (CLOSED_STATES.has(expense.state)) throw new ServiceError(400, `Expense is ${expense.state}`);
      if (reimburseeUnknown(expense)) throw new ServiceError(409, "The reimbursee is unknown; FINANCE sets it before anyone signs");
      if (seat === "PROGRAM_APPROVER") {
        const approval = await tx.lineItemOwnerApproval.findFirst({ where: { lineItemId }, select: { ownerId: true } });
        if (approval?.ownerId == null) throw new ServiceError(409, "The line has no budget bucket yet; FINANCE assigns one before the program approver signs");
      }

      const facts = (await signoffFactsByLine(tx, expense)).get(lineItemId)!;
      const filled = (await filledSeatsByLine(tx, expense.id)).get(lineItemId) ?? [];
      const refusal = signoffRefusal(facts, filled, seat, actor.userId);
      if (refusal) throw new ServiceError(403, refusal);

      await tx.expenseLineSignoff.create({
        data: { expenseId: expense.id, lineItemId, seat, signerUserId: actor.userId, signerUsername: actor.username },
      });
      await writeAudit(tx, actor, { expenseId: expense.id, action: "signoff", lineItemId, fieldChanged: "seat", valueAfter: seat });
      return { expense, facts, filled };
    })
    .catch((err: unknown) => {
      // The seat or the signer was taken by a concurrent sign-off.
      if (isUniqueConstraintError(err)) throw new ServiceError(409, "Seat already filled or signer already seated");
      throw err;
    });

  const { expense, facts, filled } = signed;
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
 * sign-off on the expense, so each seat is signed again for the new payee.
 */
export const setReimbursee: SetReimbursee = async (orgId, expenseId, personId, principal) => {
  await assertOrg(orgId);
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

  const state = await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const current = (await tx.expense.findUnique({ where: { id: expenseId } }))!;
    if (CLOSED_STATES.has(current.state)) throw new ServiceError(400, `Expense is ${current.state}`);
    await tx.expense.update({ where: { id: expenseId }, data: { reimburseePersonId: personId } });
    await writeAudit(tx, actor, {
      expenseId,
      action: "reimbursee_set",
      fieldChanged: "reimburseePersonId",
      valueBefore: current.reimburseePersonId === null ? null : String(current.reimburseePersonId),
      valueAfter: String(personId),
    });
    // Every seat was signed for the previous payee, so each is signed again for the new one.
    await voidSignoffs(tx, actor, expenseId, null, "the reimbursee changed");
    await tx.expenseFlag.updateMany({
      where: { expenseId, kind: "REIMBURSEE_UNKNOWN", checkedOffAt: null },
      data: { checkedOffAt: new Date(), checkedOffByUserId: actor.userId, checkedOffByUsername: actor.username, notes: "reimbursee set" },
    });
    return current.state;
  });

  if (state === "qb_pending") await drainExpense(orgId, expenseId);
};

/** Per line: the seats filled, still missing, and blocked (held until finance or the board acts). */
export async function signoffStatus(expenseId: string) {
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  const [facts, filled] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expenseId)]);
  return [...facts].map(([lineItemId, f]) => {
    const seats = filled.get(lineItemId) ?? [];
    return { lineItemId, filled: seats, missing: missingSeats(f, seats), blocked: blockedSeats(f, seats) };
  });
}
