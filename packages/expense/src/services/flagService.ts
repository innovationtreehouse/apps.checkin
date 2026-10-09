// GC-FIN-CONTROL flags: raised for awareness, checked off by the audience they route to, audited.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { FLAG_AUDIENCE, type FlagAudience, type FlagKind } from "../lib/flags";
import { CLOSED_STATES, reimburseeUnknown } from "../lib/signoff";
import { ServiceError } from "./serviceError";

/** Raises a flag once per expense and kind; a repeat is a no-op. */
export async function raiseFlag(expenseId: string, kind: FlagKind, detail: string | null = null): Promise<void> {
  await db.expenseFlag.createMany({
    data: [{ orgId: await getOrgId(), expenseId, kind, audience: FLAG_AUDIENCE[kind], detail }],
    skipDuplicates: true,
  });
}

function audiencesOf(principal: ExpensePrincipal): FlagAudience[] {
  return [...(principal.isFinance ? ["FINANCE" as const] : []), ...(principal.isBoard ? ["BOARD" as const] : [])];
}

export async function listOpenFlags(principal: ExpensePrincipal) {
  actorOf(principal);
  return db.expenseFlag.findMany({
    where: { orgId: await getOrgId(), checkedOffAt: null, audience: { in: audiencesOf(principal) } },
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
  if (flag.kind === "REIMBURSEE_UNKNOWN") {
    // The flag is the queue's only sign of the hold, so it stays open while the hold applies.
    const expense = await db.expense.findFirst({ where: { id: flag.expenseId } });
    if (expense && reimburseeUnknown(expense) && !CLOSED_STATES.has(expense.state)) {
      throw new ServiceError(409, "Set the reimbursee to clear this flag");
    }
  }

  await db.$transaction(async (tx) => {
    await tx.expenseFlag.update({
      where: { id: flagId },
      data: { checkedOffAt: new Date(), checkedOffByUserId: actor.userId, checkedOffByUsername: actor.username, notes },
    });
    await writeAudit(tx, actor, { expenseId: flag.expenseId, action: "flag_checked_off", valueAfter: flag.kind, notes });
  });
}
