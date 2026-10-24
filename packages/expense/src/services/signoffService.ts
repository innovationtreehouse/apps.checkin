// Sign-off seats on reimbursement and card-charge lines (F2 / F2-COI), signed in order around the
// line's approval. The signer is always the principal; a line with an unfilled seat holds its
// expense out of the QB outbox.
import type { Expense, Prisma } from "../generated/prisma/client";
import { db, isUniqueConstraintError } from "../db";
import type { ExpensePrincipal, SetReimbursee } from "../contract";
import { assertOrg, getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { drainExpense } from "../lib/financial-flow";
import { boardApprovalNeeded, clearFrom, conflictedParties, filledSeatsByLine, lineHolds, lockExpense, signoffFactsByLine, unsignedLines } from "../lib/signoff-facts";
import { CLOSED_STATES, blockedSeats, boardAuthorizationRefusal, missingSeats, reimburseeUnknown, signoffRefusal, type FilledSeat, type Seat, type SignoffFacts } from "../lib/signoff";
import { lineActions, mayRecordBoardAuthorization, signatureTab } from "../lib/line-actions";
import { lookupCatalogInfo, saveCatalogSnapshots } from "../lib/expense-qb-processor";
import { logError } from "../lib/logger";
import { closeAnsweredFlag, raiseFlag } from "./flagService";
import { SIGNOFF_BADGE_EXPENSE_CAP } from "./badgeCounts";
import { ServiceError } from "@checkin/component-kit";

type Actor = ReturnType<typeof actorOf>;
type SignedLine = { lineItemId: number; seat: Seat; facts: SignoffFacts; filled: FilledSeat[] };

/** Refuses an expense that takes no sign-off now. */
function requireSignable(expense: { backfill: boolean; state: string; needsReimbursement: boolean; reimburseePersonId: number | null }): void {
  if (expense.backfill) throw new ServiceError(400, "A backfilled expense is already booked; it takes no sign-off");
  if (CLOSED_STATES.has(expense.state)) throw new ServiceError(400, `Expense is ${expense.state}`);
  if (reimburseeUnknown(expense)) throw new ServiceError(409, "The reimbursee is unknown; FINANCE sets it before anyone signs");
}

/** Checks and records one seat, inside a transaction holding the expense lock. */
async function signLocked(tx: Prisma.TransactionClient, actor: Actor, expense: Expense, lineItemId: number, seat: Seat): Promise<SignedLine> {
  const facts = (await signoffFactsByLine(tx, expense)).get(lineItemId)!;
  const filled = (await filledSeatsByLine(tx, expense.id)).get(lineItemId) ?? [];
  const refusal = signoffRefusal(facts, filled, seat, actor.userId);
  if (refusal) throw new ServiceError(403, refusal);
  await tx.expenseLineSignoff.create({
    data: { expenseId: expense.id, lineItemId, seat, signerUserId: actor.userId, signerUsername: actor.username },
  });
  await writeAudit(tx, actor, { expenseId: expense.id, action: "signoff", lineItemId, fieldChanged: "seat", valueAfter: seat });
  return { lineItemId, seat, facts, filled };
}

/** The seat or the signer was taken by a concurrent sign-off. */
function seatTaken(err: unknown): never {
  if (isUniqueConstraintError(err)) throw new ServiceError(409, "Seat already filled or signer already seated");
  throw err;
}

/** After the seats commit: the Board stand-in and held flags, the catalog snapshot, and the drain once every line is signed. */
async function afterSigning(actor: Actor, expense: Expense, signed: SignedLine[]): Promise<void> {
  const actorHousehold = (await getExpenseRuntime().signoff.householdOf([actor.userId])).filter((id) => id !== actor.userId);
  for (const { lineItemId, seat, facts, filled } of signed) {
    const nowFilled = [...filled, { seat, signerUserId: actor.userId }];
    if (seat === "TREASURER" && !facts.finance.includes(actor.userId)) {
      await raiseFlag(expense.id, "COI", "no FINANCE holder could sign; a Board member took the Treasurer seat");
    }
    const nowFacts = { ...facts, seatedHouseholds: [...facts.seatedHouseholds, ...actorHousehold] };
    const blocked = blockedSeats(nowFacts, nowFilled);
    if (blocked.some((s) => s !== "BOARD")) {
      await raiseFlag(expense.id, "COI", `${facts.kind === "card_charge" ? "a card charge needs a second" : "a reimbursement needs a third"} Board substitution; held`);
    }
    if (blocked.includes("BOARD")) await raiseFlag(expense.id, "COI", "no Board member without a conflict can take the Board seat; held");
    if (missingSeats(facts, nowFilled).length === 0) await snapshotCatalog(lineItemId, expense.vendorName ?? "", expense.id);
  }
  if (expense.state === "qb_pending" && (await unsignedLines(db, expense)).size === 0) {
    await drainExpense(expense.orgId, expense.id);
  }
}

export async function signLine(principal: ExpensePrincipal, lineItemId: number, seat: Seat): Promise<void> {
  const actor = actorOf(principal);
  const line = await db.expenseLineItem.findFirst({
    where: { id: lineItemId, expense: { orgId: await getOrgId() } },
    select: { expenseId: true },
  });
  if (!line) throw new ServiceError(404, "Line item not found");

  // Facts are read under the expense row lock, so a reimbursee or bucket change cannot commit
  // between the eligibility check and the insert.
  const { expense, signed } = await db
    .$transaction(async (tx) => {
      await lockExpense(tx, line.expenseId);
      const expense = (await tx.expense.findUnique({ where: { id: line.expenseId } }))!;
      requireSignable(expense);
      return { expense, signed: await signLocked(tx, actor, expense, lineItemId, seat) };
    })
    .catch(seatTaken);
  await afterSigning(actor, expense, [signed]);
}

/**
 * Sign all as Treasurer: signs the Treasurer seat on every listed line of the expense under one
 * expense lock, each through the same checks as a single signature, or none of them. A refusal
 * names the line by its number.
 */
export async function signLines(principal: ExpensePrincipal, expenseId: string, lineItemIds: number[]): Promise<void> {
  const actor = actorOf(principal);
  const ids = [...new Set(lineItemIds)];
  if (ids.length === 0) throw new ServiceError(400, "Name at least one line to sign");

  const { expense, signed } = await db
    .$transaction(async (tx) => {
      await lockExpense(tx, expenseId);
      const expense = await tx.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() } });
      if (!expense) throw new ServiceError(404, "Expense not found");
      requireSignable(expense);
      const lines = await tx.expenseLineItem.findMany({ where: { expenseId, id: { in: ids } }, select: { id: true, lineNumber: true }, orderBy: { lineNumber: "asc" } });
      if (lines.length !== ids.length) throw new ServiceError(404, "Line item not found");
      const signed: SignedLine[] = [];
      for (const line of lines) {
        try {
          signed.push(await signLocked(tx, actor, expense, line.id, "TREASURER"));
        } catch (err) {
          if (err instanceof ServiceError) throw new ServiceError(err.status, `Line ${line.lineNumber}: ${err.message}`);
          throw err;
        }
      }
      return { expense, signed };
    })
    .catch(seatTaken);
  await afterSigning(actor, expense, signed);
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
 * Names the uploader, or the live Person the uploader's id resolves to, as the Person owed a
 * reimbursement whose reimbursee is unknown, clears REIMBURSEE_UNKNOWN,
 * and voids every non-submitter sign-off on the expense, so each seat is signed for that payee.
 * A known reimbursee is never changed.
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
  // Only the uploader, who said they paid, is reimbursed.
  if (personId !== (await dir.livePersonFor(expense.submitterId))) {
    throw new ServiceError(403, "Only the person who uploaded the receipt can be named as reimbursee");
  }
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
    await clearFrom(tx, actor, expenseId, null, "TREASURER", "the reimbursee was set");
    await closeAnsweredFlag(tx, expenseId, "REIMBURSEE_UNKNOWN", actor, "reimbursee set");
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
 * FINANCE holder records it, else a Board member), and once recorded it is not changed. It closes
 * THRESHOLD_CROSSED, which asks the same question.
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
    await closeAnsweredFlag(tx, expenseId, "THRESHOLD_CROSSED", actor, "Board authorization recorded");
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

/**
 * Sign-off status as the caller sees it: each line also carries the acts the caller may take there,
 * what it waits on otherwise, and whether the caller may record the expense's Board authorization.
 */
export async function signoffStatusFor(principal: ExpensePrincipal, expenseId: string) {
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  return (await callerLines(principal, expense)).map(({ facts: _facts, ...status }) => status);
}

/** Each line's status with its facts, for the caller; `readOnly` reads without taking a seat lock. */
async function callerLines(principal: ExpensePrincipal, expense: Expense, readOnly = false) {
  const [facts, filled, approvalNeeded, approvals] = await Promise.all([
    signoffFactsByLine(db, expense, { readOnly }),
    filledSeatsByLine(db, expense.id),
    boardApprovalNeeded(db, expense),
    db.lineItemOwnerApproval.findMany({ where: { expenseId: expense.id }, select: { lineItemId: true, status: true, ownerId: true } }),
  ]);
  const caller = { id: actorOf(principal).userId, isFinance: principal.isFinance };
  const held = { state: expense.state, backfill: expense.backfill, reimburseeUnknown: reimburseeUnknown(expense) };
  const approvalOf = new Map(approvals.map((a) => [a.lineItemId, a]));
  const mayRecord = mayRecordBoardAuthorization({
    callerId: caller.id,
    expense: { ...held, boardAuthorization: expense.boardAuthorization },
    factsByLine: [...facts.values()],
    boardApprovalNeeded: approvalNeeded,
  });
  return [...facts].map(([lineItemId, f]) => {
    const seats = filled.get(lineItemId) ?? [];
    const holds = lineHolds(approvalNeeded, f, seats);
    const { actions, awaiting } = lineActions({ caller, expense: held, approval: approvalOf.get(lineItemId) ?? null, facts: f, filled: seats, holds });
    return { lineItemId, filled: seats, missing: holds, blocked: blockedSeats(f, seats), actions, awaiting, mayRecordBoardAuthorization: mayRecord, facts: f };
  });
}

/** One expense's lines waiting for a signature the caller may give, by Finance review tab. */
export interface SignaturesWaiting {
  expense: Expense;
  toSign: number[];
  board: number[];
}

/**
 * The lines waiting for a Treasurer or Board signature this caller may give, from the line-actions
 * function, so a line is listed only once the steps before its signature are done. Reads at most
 * SIGNOFF_BADGE_EXPENSE_CAP open expenses with an approved line (newest first), as the sign-off
 * badges do; an expense with nothing for the caller is left out.
 */
export async function signaturesWaiting(principal: ExpensePrincipal): Promise<SignaturesWaiting[]> {
  if (!principal.isFinance && !principal.isBoard) return [];
  const me = actorOf(principal).userId;
  const expenses = await db.expense.findMany({
    where: {
      orgId: await getOrgId(),
      backfill: false,
      state: { notIn: [...CLOSED_STATES] },
      NOT: { needsReimbursement: true, reimburseePersonId: null },
      approvals: { some: { status: "approved" } },
    },
    orderBy: { submittedAt: "desc" },
    take: SIGNOFF_BADGE_EXPENSE_CAP,
  });
  const out: SignaturesWaiting[] = [];
  for (const expense of expenses) {
    const row: SignaturesWaiting = { expense, toSign: [], board: [] };
    for (const line of await callerLines(principal, expense, true)) {
      for (const action of line.actions) {
        const tab = signatureTab(line.facts, action, me);
        if (tab) row[tab].push(line.lineItemId);
      }
    }
    if (row.toSign.length + row.board.length > 0) out.push(row);
  }
  return out;
}
