// Expense's side of match-before-create (QB-2). The shared find-or-create in
// @checkin/quickbooks is stateless; expense hands it the closed-books gate and the ids it must skip.
import { appKeyOf, qbKey, type QboPurchase, type QuickBooksClient } from "@checkin/quickbooks";
import { db, isUniqueConstraintError, type Db } from "../db";
import { QuickBooksNotConnectedError, type ExpensePrincipal, type QbTxn } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { writeAudit, writeOrgAudit } from "../lib/audit";
import { matchedBaseline } from "../lib/expense-qb-drift";
import { actorOf } from "../lib/caller";
import { lockExpense, unsignedLines } from "../lib/signoff-facts";
import { reimburseeUnknown } from "../lib/signoff";
import { requireFinance } from "./approvalService";
import { ServiceError } from "@checkin/component-kit";

/** A reimbursement matches a Bill; every other line matches a Purchase. */
export type QbMatchEntity = "Bill" | "Purchase";

/**
 * Claims a QuickBooks entry for an expense or a line inside the caller's transaction; false when
 * it is already claimed. Never throws on a conflict, so the caller's transaction stays usable.
 */
export async function claimQbTxn(tx: Db, orgId: string, qbTxnEntity: string, qbTxnId: string): Promise<boolean> {
  const { count } = await tx.expenseQbClaim.createMany({ data: [{ orgId, qbTxnEntity, qbTxnId }], skipDuplicates: true });
  return count === 1;
}

/** What QuickBooks holds under an expense's key since its first create attempt. */
export type OwnEntry =
  | { kind: "none" }
  | { kind: "own"; entry: QboPurchase }
  | { kind: "held"; note: string }
  | { kind: "unsure"; note: string }
  | { kind: "failed"; note: string };

/** Every app key a QuickBooks entry's memo carries. */
export const appKeysOf = (entry: QboPurchase) => appKeyOf(entry)?.split(" ") ?? [];

/**
 * For an expense the app may already have created in QuickBooks: every `entity` QuickBooks created
 * since its first attempt, kept to those carrying its key. Creation time does not change when
 * finance edits the date, so a re-dated entry is still found. An entry carrying another key
 * beside it, several keyed entries, or a full page is unsure; an entry another expense or line
 * holds is held.
 */
export async function lookupOwnEntry(
  client: QuickBooksClient,
  orgId: string,
  expenseId: string,
  entity: QbMatchEntity,
  since: Date,
): Promise<OwnEntry> {
  let read: { entries: QboPurchase[]; full: boolean };
  try {
    read = await client.createdSince(entity, since);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { kind: "failed", note: `the app may already have booked this expense: the QuickBooks read failed (${error.slice(0, 200)})` };
  }
  if (read.full) return { kind: "unsure", note: `the app may already have booked this expense: QuickBooks returned a full page of ${entity}s created since its first attempt` };
  const key = qbKey("expense", expenseId);
  const keyed = read.entries.filter((e) => appKeysOf(e).includes(key));
  if (keyed.length === 0) return { kind: "none" };
  if (keyed.length > 1 || appKeyOf(keyed[0]) !== key) {
    return { kind: "unsure", note: `the app may already have booked this expense: ${entity}s ${keyed.map((e) => e.Id).join(", ")} carry its key` };
  }
  const entry = keyed[0];
  const [expense, line] = await Promise.all([
    db.expense.findFirst({ where: { orgId, qbTxnEntity: entity, qbTxnId: entry.Id, id: { not: expenseId } }, select: { id: true } }),
    db.expenseLineItem.findFirst({ where: { qbTxnEntity: entity, qbTxnId: entry.Id, expense: { orgId } }, select: { expenseId: true } }),
  ]);
  if (expense) return { kind: "held", note: `app entry ${entity} ${entry.Id} is held by expense ${expense.id}` };
  if (line) return { kind: "held", note: `app entry ${entity} ${entry.Id} is held by a line of expense ${line.expenseId}` };
  return { kind: "own", entry };
}

/** QuickBooks ids of one entity type held by any expense or line. */
export async function claimedQbTxnIds(orgId: string, qbTxnEntity: string): Promise<string[]> {
  const rows = await db.expenseQbClaim.findMany({ where: { orgId, qbTxnEntity }, select: { qbTxnId: true } });
  return rows.map((r) => r.qbTxnId);
}

export interface QbMatchInputs {
  /** QuickBooks ids of the entity type already claimed by an expense or a line, or excluded by finance: never a candidate. */
  skipIds: string[];
}

export async function qbMatchInputs(entity: QbMatchEntity): Promise<QbMatchInputs> {
  const orgId = await getOrgId();
  const [claimed, excluded] = await Promise.all([
    claimedQbTxnIds(orgId, entity),
    db.expenseQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
  ]);
  return { skipIds: [...claimed, ...excluded.map((e) => e.qbTxnId)] };
}

/** Finance permanently removes a QuickBooks transaction from matching, with a reason. */
export async function excludeQbTxn(principal: ExpensePrincipal, qbTxnId: string, reason: string): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  if (!reason.trim()) throw new ServiceError(400, "A reason is required");
  const orgId = await getOrgId();
  try {
    await db.$transaction(async (tx) => {
      await tx.expenseQbMatchExclusion.create({
        data: { orgId, qbTxnId, reason: reason.trim(), excludedByUserId: actor.userId, excludedByUsername: actor.username },
      });
      await writeOrgAudit(tx, orgId, actor, { entityType: "qb_txn", entityId: qbTxnId, action: "excluded", after: { reason: reason.trim() } });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "Already excluded");
    throw err;
  }
}

/** Days either side of a line's receipt date that a QuickBooks candidate may fall in. */
export const MATCH_WINDOW_DAYS = 7;

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadExpense(expenseId: string) {
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() }, include: { lineItems: true } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  return expense;
}

/** Expense states that may still be linked to an existing QuickBooks entry; BEFORE_LINE is held as UNBOOKED. */
const MATCHABLE_STATES = ["UNMATCHED", "AMBIGUOUS", "UNBOOKED", "BEFORE_LINE", "POST_FAILED", "NEEDS_FINANCE"];

/**
 * The total the poster would book: every line plus the expense's tax and shipping, less its discount.
 * Read from the expense, since line allocations are set only once the expense is processed.
 */
function postedTotalCents(expense: Awaited<ReturnType<typeof loadExpense>>): number {
  const lines = expense.lineItems.reduce((sum, l) => sum + l.totalPriceCents, 0);
  return lines + expense.taxCents + expense.shippingCents - expense.discountCents;
}

async function candidatesFor(expense: Awaited<ReturnType<typeof loadExpense>>): Promise<{ entity: QbMatchEntity; txns: QbTxn[] }> {
  const entity: QbMatchEntity = expense.needsReimbursement ? "Bill" : "Purchase";
  const date = expense.receiptDate;
  if (!date) return { entity, txns: [] };
  const from = shiftDate(date, -MATCH_WINDOW_DAYS);
  const to = shiftDate(date, MATCH_WINDOW_DAYS);
  const { reader, refs } = getExpenseRuntime().quickbooks;
  const personId = expense.reimburseePersonId;
  const expectedRef =
    entity === "Bill" ? (personId === null ? null : await refs.vendorIdFor(personId)) : await refs.paymentAccountId();
  if (expectedRef === null) return { entity, txns: [] };
  const txns = await (entity === "Bill" ? reader.billsBetween(from, to) : reader.purchasesBetween(from, to)).catch((err: unknown) => {
    if (err instanceof QuickBooksNotConnectedError) throw new ServiceError(503, err.message);
    throw err;
  });
  const skip = new Set((await qbMatchInputs(entity)).skipIds);
  const totalCents = postedTotalCents(expense);
  const matches = (t: QbTxn) =>
    t.totalCents === totalCents &&
    t.txnDate >= from &&
    t.txnDate <= to &&
    (entity === "Bill" ? t.vendorRef : t.accountRef) === expectedRef &&
    !skip.has(t.id);
  return { entity, txns: txns.filter(matches) };
}

/**
 * QuickBooks entries an expense may match: a Bill for a reimbursement, else a Purchase, of the
 * total the poster would book, inside the window around its receipt date, booked against the
 * expected vendor or payment account, never claimed or excluded.
 */
export async function qbCandidates(principal: ExpensePrincipal, expenseId: string): Promise<QbTxn[]> {
  requireFinance(principal);
  return (await candidatesFor(await loadExpense(expenseId))).txns;
}

/**
 * Before finance matches an expense whose create may already have landed, look for the app's own
 * entry. Found → the expense is linked to it as CREATED, in place of the match, and true is
 * returned. Held by another record, or unsure → refused; a failed read answers 503. Nothing found,
 * or never attempted → false, and the match goes ahead.
 */
async function linkOwnFirst(expense: Awaited<ReturnType<typeof loadExpense>>, entity: QbMatchEntity, principal: ExpensePrincipal): Promise<boolean> {
  if (!expense.qbCreateAttemptedAt) return false;
  const posting = await getExpenseRuntime().quickbooks.posting();
  if (!posting) throw new ServiceError(503, "QuickBooks is not connected");
  const own = await lookupOwnEntry(posting.client, expense.orgId, expense.id, entity, expense.qbCreateAttemptedAt);
  switch (own.kind) {
    case "none":
      return false;
    case "failed":
      throw new ServiceError(503, own.note);
    case "held":
    case "unsure":
      throw new ServiceError(409, own.note);
    case "own":
      break;
  }
  const qbTxnId = own.entry.Id;
  try {
    await db.$transaction(async (tx) => {
      // Linking books the expense as much as a match does, so it takes the same sign-offs, read under the lock.
      await lockExpense(tx, expense.id);
      const current = await tx.expense.findUniqueOrThrow({ where: { id: expense.id } });
      if (reimburseeUnknown(current) || (await unsignedLines(tx, current)).size > 0) {
        throw new ServiceError(409, "Expense is missing a required sign-off or the Board's approval");
      }
      const linked = await tx.expense.updateMany({
        where: { id: expense.id, qbTxnId: null, qbMatchState: { in: MATCHABLE_STATES } },
        data: { qbMatchState: "CREATED", qbTxnId, qbTxnEntity: entity, qbVendorId: entity === "Bill" ? own.entry.VendorRef?.value ?? null : null },
      });
      if (linked.count === 0) throw new ServiceError(409, "Expense is already linked to QuickBooks");
      if (!(await claimQbTxn(tx, expense.orgId, entity, qbTxnId))) throw new ServiceError(409, "That QuickBooks entry is already claimed");
      await writeAudit(tx, actorOf(principal), {
        expenseId: expense.id,
        action: "qb_created",
        fieldChanged: "qbMatchState",
        valueBefore: expense.qbMatchState,
        valueAfter: `CREATED:${qbTxnId}`,
        notes: `the app had already booked this expense as ${entity} ${qbTxnId}; the match was not applied`,
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, `The app's QuickBooks ${entity} ${qbTxnId} is already claimed by another expense`);
    throw err;
  }
  return true;
}

/**
 * Finance links an expense to an existing QuickBooks entry; an entry is claimed once across expenses and lines.
 * The entry must be one of the expense's own candidates, and every line fully signed off. An
 * expense whose create may already have landed links to the app's own entry first, when there is one.
 * A matched expense holds a qbTxnId, so the poster never books it again.
 */
export async function matchExpenseToQb(principal: ExpensePrincipal, expenseId: string, qbTxnId: string): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const expense = await loadExpense(expenseId);
  if (expense.qbTxnId) throw new ServiceError(409, "Expense is already linked to QuickBooks");
  if (!MATCHABLE_STATES.includes(expense.qbMatchState) || expense.state === "rejected" || expense.backfill) {
    throw new ServiceError(409, "Expense is not in a state that can be matched");
  }
  const entity: QbMatchEntity = expense.needsReimbursement ? "Bill" : "Purchase";
  if (await linkOwnFirst(expense, entity, principal)) return;
  const { txns } = await candidatesFor(expense);
  const picked = txns.find((t) => t.id === qbTxnId);
  if (!picked) throw new ServiceError(409, "That QuickBooks entry is not a candidate for this expense");
  const qbMatchBaseline = matchedBaseline({ amountCents: picked.totalCents, txnDate: picked.txnDate, vendorId: entity === "Bill" ? picked.vendorRef : null });
  try {
    await db.$transaction(async (tx) => {
      // Sign-offs are read under the expense lock, so a concurrent void cannot slip past the check.
      await lockExpense(tx, expenseId);
      const current = (await tx.expense.findUnique({ where: { id: expenseId } }))!;
      if (reimburseeUnknown(current) || (await unsignedLines(tx, current)).size > 0) {
        throw new ServiceError(409, "Expense is missing a required sign-off or the Board's approval");
      }
      const linked = await tx.expense.updateMany({
        where: { id: expenseId, qbTxnId: null, qbMatchState: { in: MATCHABLE_STATES } },
        data: { qbMatchState: "MATCHED", qbTxnId, qbTxnEntity: entity, qbMatchBaseline },
      });
      if (linked.count === 0) throw new ServiceError(409, "Expense is already linked to QuickBooks");
      if (!(await claimQbTxn(tx, current.orgId, entity, qbTxnId))) throw new ServiceError(409, "That QuickBooks entry is already claimed");
      await writeAudit(tx, actor, {
        expenseId,
        action: "qb_matched",
        fieldChanged: "qbMatchState",
        valueBefore: current.qbMatchState,
        valueAfter: `MATCHED:${qbTxnId}`,
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "That QuickBooks entry is already claimed by another expense");
    throw err;
  }
}
