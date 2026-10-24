// Finance reviews (ExpenseFlag rows of the kept kinds): raised by the QuickBooks paths, checked off with a note, audited.
import { db, type Db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { FLAG_AUDIENCE, FLAG_KINDS, isFlagKind, taxNeedsFinance, type FlagAudience, type FlagKind } from "../lib/flags";
import { conflictedParties } from "../lib/signoff-facts";
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

export async function checkOffFlag(principal: ExpensePrincipal, flagId: number, notes: string | null = null): Promise<void> {
  const actor = actorOf(principal);
  const flag = await db.expenseFlag.findFirst({ where: { id: flagId, orgId: await getOrgId() } });
  if (!flag) throw new ServiceError(404, "Flag not found");
  if (!isFlagKind(flag.kind)) throw new ServiceError(409, "This kind is no longer checked off; the finance queue reads it from the expense");
  if (!audiencesOf(principal).includes(flag.audience as FlagAudience)) {
    throw new ServiceError(403, `Only ${flag.audience} can check off this flag`);
  }
  if (flag.checkedOffAt) throw new ServiceError(400, "Flag is already checked off");
  const expense = (await db.expense.findFirst({ where: { id: flag.expenseId } }))!;
  // A control flag is checked off by someone independent of the expense, never by its submitter,
  // its reimbursee, or anyone in their households.
  if ((await conflictedParties(expense)).includes(actor.userId)) {
    throw new ServiceError(403, "You are a party to this expense and cannot check off its flags");
  }

  await db.$transaction(async (tx) => {
    await tx.expenseFlag.update({
      where: { id: flagId },
      data: { checkedOffAt: new Date(), checkedOffByUserId: actor.userId, checkedOffByUsername: actor.username, notes },
    });
    await writeAudit(tx, actor, { expenseId: flag.expenseId, action: "flag_checked_off", valueAfter: flag.kind, notes });
  });
}
