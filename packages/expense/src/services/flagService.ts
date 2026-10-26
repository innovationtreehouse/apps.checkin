// Finance reviews (ExpenseFlag rows of the kept kinds): raised by the QuickBooks paths, checked off with a note, audited.
import { db, type Db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { SYSTEM_ACTOR } from "../lib/system-actor";
import { FLAG_AUDIENCE, FLAG_KINDS, isFlagKind, taxNeedsFinance, type FlagAudience, type FlagKind } from "../lib/flags";
import { conflictedParties, lockExpense } from "../lib/signoff-facts";
import { ServiceError } from "@checkin/component-kit";

/**
 * Raises a flag; one row per expense and kind, so raising a checked-off flag reopens it.
 * `observed` is what the raiser saw, for comparing a later raise against a check-off.
 */
export async function raiseFlag(expenseId: string, kind: FlagKind, detail: string | null = null, client: Db = db, observed: string | null = null): Promise<void> {
  const raised = { audience: FLAG_AUDIENCE[kind], detail, observed, raisedAt: new Date() };
  const reopened = { ...raised, checkedOffAt: null, checkedOffByUserId: null, checkedOffByUsername: null, notes: null };
  const reopen = await client.expenseFlag.updateMany({ where: { expenseId, kind, checkedOffAt: { not: null } }, data: reopened });
  if (reopen.count > 0) return;
  await client.expenseFlag.createMany({ data: [{ orgId: await getOrgId(), expenseId, kind, ...raised }], skipDuplicates: true });
}

/** The entries a QB_DUPLICATE_TO_VOID row has raised, from its `observed` list. */
function strayEntriesOf(observed: string | null): string[] {
  const parsed: unknown = observed ? JSON.parse(observed) : [];
  return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
}

/**
 * Raises QB_DUPLICATE_TO_VOID for one QuickBooks entry ("Purchase:123"); false when the row already
 * raised it. The row lists every entry it has raised, so an entry finance checked off stays
 * answered; a new entry reopens a checked-off row, or joins an open row's detail. Call it under the
 * expense's lock.
 */
export async function raiseStray(tx: Db, expenseId: string, entry: string, detail: string): Promise<boolean> {
  const flag = await tx.expenseFlag.findFirst({ where: { expenseId, kind: "QB_DUPLICATE_TO_VOID" } });
  const raised = strayEntriesOf(flag?.observed ?? null);
  if (raised.includes(entry)) return false;
  const observed = JSON.stringify([...raised, entry]);
  if (flag && !flag.checkedOffAt) {
    await tx.expenseFlag.update({ where: { id: flag.id }, data: { detail: [flag.detail, detail].filter(Boolean).join("; "), observed } });
  } else {
    await raiseFlag(expenseId, "QB_DUPLICATE_TO_VOID", detail, tx, observed);
  }
  return true;
}

/** Text a QB_POST_HELD check-off carries when the expense's posting settles the hold. */
export const POSTED_CHECK_OFF = "posted to QuickBooks";

/** An expense linked to its QuickBooks entry no longer waits on finance: its open QB_POST_HELD is checked off. */
export async function checkOffHeldOnPost(tx: Db, expenseId: string): Promise<void> {
  const { count } = await tx.expenseFlag.updateMany({
    where: { expenseId, kind: "QB_POST_HELD", checkedOffAt: null },
    data: { checkedOffAt: new Date(), checkedOffByUserId: SYSTEM_ACTOR.userId, checkedOffByUsername: SYSTEM_ACTOR.username, notes: POSTED_CHECK_OFF },
  });
  if (count > 0) await writeAudit(tx, SYSTEM_ACTOR, { expenseId, action: "flag_checked_off", valueAfter: "QB_POST_HELD", notes: POSTED_CHECK_OFF });
}

/** Whether the stored expense's tax still waits on finance, from its stored receipt review. */
export async function storedTaxNeedsFinance(expenseId: string, client: Db = db): Promise<boolean> {
  const { taxCents, receiptReview } = await client.expense.findUniqueOrThrow({
    where: { id: expenseId },
    select: { taxCents: true, receiptReview: { select: { taxReviewRequired: true, reasons: true, approvedTaxCents: true } } },
  });
  return taxNeedsFinance(taxCents, receiptReview);
}

function audiencesOf(principal: ExpensePrincipal): FlagAudience[] {
  return [...(principal.isFinance ? ["FINANCE" as const] : []), ...(principal.isBoard ? ["BOARD" as const] : [])];
}

/** Open reviews of the kept kinds for the caller's audience. */
export async function listOpenFlags(principal: ExpensePrincipal) {
  actorOf(principal);
  return db.expenseFlag.findMany({
    where: { orgId: await getOrgId(), checkedOffAt: null, kind: { in: [...FLAG_KINDS] }, audience: { in: audiencesOf(principal) } },
    orderBy: { raisedAt: "asc" },
  });
}

/** The review as finance was shown it; a check-off answers that version only. */
export type ShownFlag = { detail: string | null; observed: string | null };

export async function checkOffFlag(principal: ExpensePrincipal, flagId: number, notes: string | null, shown: ShownFlag): Promise<void> {
  const actor = actorOf(principal);
  const flag = await db.expenseFlag.findFirst({ where: { id: flagId, orgId: await getOrgId() } });
  if (!flag) throw new ServiceError(404, "Flag not found");
  if (!isFlagKind(flag.kind)) throw new ServiceError(409, "This kind is no longer checked off; the finance queue reads it from the expense");
  if (!audiencesOf(principal).includes(flag.audience as FlagAudience)) {
    throw new ServiceError(403, `Only ${flag.audience} can check off this flag`);
  }
  if (flag.checkedOffAt) throw new ServiceError(400, "Flag is already checked off");
  // A review is a finance to-do; the note says what finance did.
  if (!notes?.trim()) throw new ServiceError(400, "Say what finance did");
  const expense = (await db.expense.findFirst({ where: { id: flag.expenseId } }))!;
  // A control flag is checked off by someone independent of the expense, never by its submitter,
  // its reimbursee, or anyone in their households.
  if ((await conflictedParties(expense)).includes(actor.userId)) {
    throw new ServiceError(403, "You are a party to this expense and cannot check off its flags");
  }

  await db.$transaction(async (tx) => {
    // Raisers write under the expense lock, so the row read here is the one the check-off answers.
    await lockExpense(tx, flag.expenseId);
    const current = await tx.expenseFlag.findUniqueOrThrow({ where: { id: flagId } });
    if (current.checkedOffAt) throw new ServiceError(400, "Flag is already checked off");
    if (current.detail !== shown.detail || current.observed !== shown.observed) {
      throw new ServiceError(409, "This review changed since it was shown; reload it and check it again");
    }
    await tx.expenseFlag.update({
      where: { id: flagId },
      data: { checkedOffAt: new Date(), checkedOffByUserId: actor.userId, checkedOffByUsername: actor.username, notes },
    });
    await writeAudit(tx, actor, { expenseId: flag.expenseId, action: "flag_checked_off", valueAfter: flag.kind, notes });
  });
}
