// Sign-off seats on reimbursement and card-charge lines (F2 / F2-COI). The signer is always the
// principal; a line with an unfilled seat holds its expense out of the QB outbox.
import type { Prisma } from "../generated/prisma/client";
import { db, isUniqueConstraintError } from "../db";
import type { ExpensePrincipal, SetReimbursee } from "../contract";
import { assertOrg, getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { drainExpense } from "../lib/financial-flow";
import { boardApprovalNeeded, conflictedParties, filledSeatsByLine, lineHolds, lockExpense, signoffFactsByLine, unsignedLines, voidSignoffs } from "../lib/signoff-facts";
import { CLOSED_STATES, blockedSeats, boardAuthorizationRefusal, missingSeats, reimburseeUnknown, signoffRefusal, type Seat } from "../lib/signoff";
import { lookupCatalogInfo, saveCatalogSnapshots } from "../lib/expense-qb-processor";
import { logError } from "../lib/logger";
import { raiseFlag } from "./flagService";
import { ServiceError } from "@checkin/component-kit";

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
  const actorHousehold = (await getExpenseRuntime().signoff.householdOf([actor.userId])).filter((id) => id !== actor.userId);
  const nowFacts = { ...facts, seatedHouseholds: [...facts.seatedHouseholds, ...actorHousehold] };
  const blocked = blockedSeats(nowFacts, nowFilled);
  if (blocked.some((s) => s !== "BOARD")) {
    await raiseFlag(expense.id, "COI", `${facts.kind === "card_charge" ? "a card charge needs a second" : "a reimbursement needs a third"} Board substitution; held`);
  }
  if (blocked.includes("BOARD")) await raiseFlag(expense.id, "COI", "no Board member without a conflict can take the Board seat; held");
  if (missingSeats(facts, nowFilled).length === 0) await snapshotCatalog(lineItemId, expense.vendorName ?? "", expense.id);
  if (expense.state === "qb_pending" && (await unsignedLines(db, expense)).size === 0) {
    await drainExpense(expense.orgId, expense.id);
  }
}

/**
 * Fixes a fully signed line's catalog inputs to its QuickBooks account. A catalog miss or
 * failure leaves it unset, and the first successful lookup at posting takes it instead.
 */
async function snapshotCatalog(lineItemId: number, vendorName: string, expenseId: string): Promise<void> {
  try {
    const line = (await db.expenseLineItem.findUnique({ where: { id: lineItemId } }))!;
    await saveCatalogSnapshots((await lookupCatalogInfo([line], vendorName)).info);
  } catch (err) {
    logError("catalog_snapshot_failed", { expenseId, lineItemId }, err);
  }
}

const REIMBURSEE_KNOWN = "The reimbursee is already set and cannot be changed";

/**
 * Names a live adult as the one owed a reimbursement whose reimbursee is unknown, clears
 * REIMBURSEE_UNKNOWN, and voids every non-submitter sign-off on the expense, so each seat is
 * signed for that payee. A known reimbursee is never changed.
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
  if (!reimburseeUnknown(expense)) throw new ServiceError(409, REIMBURSEE_KNOWN);
  const dir = getExpenseRuntime().signoff;
  if (!(await dir.personExists(personId))) throw new ServiceError(404, "Person not found");
  if (!(await dir.isAdult(personId))) throw new ServiceError(400, "Only an adult can be named as reimbursee");
  if ((await conflictedParties({ submitterId: expense.submitterId, reimburseePersonId: personId })).includes(actor.userId)) {
    throw new ServiceError(403, "You cannot name the reimbursee on an expense that you or your household submitted or would be reimbursed for");
  }

  const state = await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const current = (await tx.expense.findUnique({ where: { id: expenseId } }))!;
    if (CLOSED_STATES.has(current.state)) throw new ServiceError(400, `Expense is ${current.state}`);
    if (!reimburseeUnknown(current)) throw new ServiceError(409, REIMBURSEE_KNOWN);
    // reimbursementFor stays as the receipt's free-text payee; reimburseePersonId is authoritative.
    await tx.expense.update({ where: { id: expenseId }, data: { reimburseePersonId: personId } });
    await writeAudit(tx, actor, {
      expenseId,
      action: "reimbursee_set",
      fieldChanged: "reimburseePersonId",
      valueBefore: null,
      valueAfter: String(personId),
    });
    // Any seat signed while the payee was unknown is signed again for the payee.
    await voidSignoffs(tx, actor, expenseId, null, "the reimbursee was set");
    await tx.expenseFlag.updateMany({
      where: { expenseId, kind: "REIMBURSEE_UNKNOWN", checkedOffAt: null },
      data: { checkedOffAt: new Date(), checkedOffByUserId: actor.userId, checkedOffByUsername: actor.username, notes: "reimbursee set" },
    });
    return current.state;
  });

  if (state === "qb_pending") await drainExpense(orgId, expenseId);
};

/** The expense, locked and open to change, or the refusal. */
async function openExpense(tx: Prisma.TransactionClient, expenseId: string) {
  await lockExpense(tx, expenseId);
  const expense = await tx.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  if (expense.backfill) throw new ServiceError(400, "A backfilled expense is already booked");
  if (CLOSED_STATES.has(expense.state)) throw new ServiceError(400, `Expense is ${expense.state}`);
  return expense;
}

/**
 * Records what the Board authorized: its own decision, or the approved program-budget line that
 * covers the purchase. It stands in for the Board seat on a card charge's org-level lines and
 * clears the hold on a purchase at or over the Board-review total; an expense needing neither
 * takes none. It is not an approval. The text is required, a conflicted caller is refused (a
 * FINANCE holder records it, else a Board member), and once recorded it is not changed.
 */
export async function recordBoardAuthorization(principal: ExpensePrincipal, expenseId: string, authorization: string): Promise<void> {
  const actor = actorOf(principal);
  const text = authorization.trim();
  if (text === "") throw new ServiceError(400, "Say what the Board authorized");
  const { state, byFinance } = await db.$transaction(async (tx) => {
    const expense = await openExpense(tx, expenseId);
    if (expense.boardAuthorization !== null) throw new ServiceError(409, "The Board authorization is already recorded");
    const facts = [...(await signoffFactsByLine(tx, expense)).values()];
    if (!facts.some((f) => f.boardSeat) && !(await boardApprovalNeeded(tx, expense))) {
      throw new ServiceError(400, "This expense takes no Board authorization: no line takes the Board seat and it is under the Board-review total");
    }
    if (reimburseeUnknown(expense)) throw new ServiceError(409, "The reimbursee is unknown; FINANCE sets it before the Board authorization is recorded");
    const refusal = boardAuthorizationRefusal(facts, actor.userId);
    if (refusal) throw new ServiceError(403, refusal);
    await tx.expense.update({
      where: { id: expenseId },
      data: { boardAuthorization: text, boardAuthorizedByUserId: actor.userId, boardAuthorizedByUsername: actor.username, boardAuthorizedAt: new Date() },
    });
    await writeAudit(tx, actor, { expenseId, action: "board_authorization_recorded", fieldChanged: "boardAuthorization", valueAfter: text });
    return { state: expense.state, byFinance: facts[0].finance.includes(actor.userId) };
  });
  if (!byFinance) await raiseFlag(expenseId, "COI", "no FINANCE holder could record it; a Board member recorded the Board authorization");
  if (state === "qb_pending") await drainExpense(await getOrgId(), expenseId);
}

/** Per line: the seats filled, what is still missing (seats, then the Board's approval), and the seats blocked (held until finance or the board acts). */
export async function signoffStatus(expenseId: string) {
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  const [facts, filled, approval] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expenseId), boardApprovalNeeded(db, expense)]);
  return [...facts].map(([lineItemId, f]) => {
    const seats = filled.get(lineItemId) ?? [];
    return { lineItemId, filled: seats, missing: lineHolds(approval, f, seats), blocked: blockedSeats(f, seats) };
  });
}
