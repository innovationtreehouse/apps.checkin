// GC-FIN-CONTROL flags: raised for awareness, checked off by the audience they route to, audited.
import type { Prisma } from "../generated/prisma/client";
import { db, type Db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { FLAG_AUDIENCE, HOLD_FLAGS, NEEDS_VOIDING, reviewKindOf, taxNeedsFinance, type FlagAudience, type FlagKind } from "../lib/flags";
import type { Actor } from "../lib/workflow-engine";
import { CLOSED_STATES, reimburseeUnknown } from "../lib/signoff";
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

/**
 * Checks off the expense's open `kind` flag as answered by the act that fixed its condition. A
 * QB_POST_FAILED duplicate to void is a review, which only a note closes, so it stays open.
 */
export async function closeAnsweredFlag(client: Db, expenseId: string, kind: FlagKind, actor: Actor, notes: string): Promise<void> {
  const notVoiding: Prisma.ExpenseFlagWhereInput = kind === "QB_POST_FAILED" ? { OR: [{ detail: null }, { NOT: { detail: { contains: NEEDS_VOIDING } } }] } : {};
  await client.expenseFlag.updateMany({
    where: { expenseId, kind, checkedOffAt: null, ...notVoiding },
    data: { checkedOffAt: new Date(), checkedOffByUserId: actor.userId, checkedOffByUsername: actor.username ?? null, notes },
  });
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

/** Open flags for the caller's audience; a hold flag drops out once its expense is closed and the hold is moot. */
export async function listOpenFlags(principal: ExpensePrincipal) {
  actorOf(principal);
  return db.expenseFlag.findMany({
    where: {
      orgId: await getOrgId(),
      checkedOffAt: null,
      audience: { in: audiencesOf(principal) },
      NOT: { kind: { in: [...HOLD_FLAGS.keys()] }, expense: { state: { in: [...CLOSED_STATES] } } },
    },
    orderBy: { raisedAt: "asc" },
  });
}

export async function checkOffFlag(principal: ExpensePrincipal, flagId: number, notes: string | null = null): Promise<void> {
  const actor = actorOf(principal);
  const flag = await db.expenseFlag.findFirst({ where: { id: flagId, orgId: await getOrgId() } });
  if (!flag) throw new ServiceError(404, "Flag not found");
  if (!audiencesOf(principal).includes(flag.audience as FlagAudience)) {
    throw new ServiceError(403, `Only ${flag.audience} can check off this flag`);
  }
  if (flag.checkedOffAt) throw new ServiceError(400, "Flag is already checked off");
  // A review is a finance to-do; the note says what finance did.
  if (reviewKindOf(flag) && !notes?.trim()) throw new ServiceError(400, "Say what finance did");
  const expense = (await db.expense.findFirst({ where: { id: flag.expenseId } }))!;
  // A control flag is checked off by someone independent of the expense, never by its submitter,
  // its reimbursee, or anyone in their households.
  if ((await conflictedParties(expense)).includes(actor.userId)) {
    throw new ServiceError(403, "You are a party to this expense and cannot check off its flags");
  }
  // A COI flag is raised by a sign-off, so no signer on the expense, nor their household, checks it off.
  // Signers come from the audit log: a voided sign-off loses its seat row but the flag stays open.
  if (flag.kind === "COI") {
    const signoffs = await db.expenseAuditLog.findMany({ where: { expenseId: flag.expenseId, action: "signoff" }, select: { userId: true } });
    const signers = [...new Set(signoffs.map((s) => s.userId))];
    if (signers.length > 0 && [...signers, ...(await getExpenseRuntime().signoff.householdOf(signers))].includes(actor.userId)) {
      throw new ServiceError(403, "You signed this expense, or are in a signer's household, and cannot check off its conflict flag");
    }
  }
  // REIMBURSEE_UNKNOWN is the queue's only sign of the hold, so it stays open while the hold applies.
  const holdReason = HOLD_FLAGS.get(flag.kind);
  if (holdReason && reimburseeUnknown(expense) && !CLOSED_STATES.has(expense.state)) {
    throw new ServiceError(409, holdReason);
  }

  await db.$transaction(async (tx) => {
    await tx.expenseFlag.update({
      where: { id: flagId },
      data: { checkedOffAt: new Date(), checkedOffByUserId: actor.userId, checkedOffByUsername: actor.username, notes },
    });
    await writeAudit(tx, actor, { expenseId: flag.expenseId, action: "flag_checked_off", valueAfter: flag.kind, notes });
  });
}
