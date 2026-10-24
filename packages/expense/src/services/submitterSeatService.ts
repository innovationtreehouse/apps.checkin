// The reimbursement submitter's seat (Financial Policy Art. IX §IX.3). The person reimbursed signs
// by confirming the receipt as read, or a Board member does on behalf of one with no account; the
// seat on each line cites that confirmation.
import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import type { SubmitterConfirmations } from "../contract";
import { writeAudit } from "../lib/audit";
import { drainExpense } from "../lib/financial-flow";
import { clearFrom, conflictedParties, lockExpense, unsignedLines } from "../lib/signoff-facts";
import { CLOSED_STATES } from "../lib/signoff";
import type { Actor } from "../lib/workflow-engine";
import { getOrgId } from "../runtime";

/** The expense audit action naming the fields of a finance change that cleared the submitter's confirmation. */
export const SUBMITTER_CONFIRMATION_VOIDED = "submitter_confirmation_voided";

/** An open reimbursement that takes sign-off: the only kind with a submitter seat. */
const TAKES_SUBMITTER_SEAT = { needsReimbursement: true, backfill: false, state: { notIn: [...CLOSED_STATES] } };

/**
 * Signs the submitter seat on each given line still without one, by `signer`: the person
 * reimbursed, or a Board member on their behalf. Each is audited citing the confirmation.
 */
export async function recordSubmitterSeats(
  tx: Prisma.TransactionClient,
  expenseId: string,
  lineItemIds: number[],
  signer: Actor,
  confirmation: { reimburseePersonId: number; confirmedAt: string },
): Promise<number> {
  const signed = new Set(
    (await tx.expenseLineSignoff.findMany({ where: { expenseId, seat: "SUBMITTER" }, select: { lineItemId: true } })).map((r) => r.lineItemId),
  );
  const onBehalf = signer.userId === confirmation.reimburseePersonId ? "" : ` on behalf of ${confirmation.reimburseePersonId}`;
  const open = lineItemIds.filter((id) => !signed.has(id));
  for (const lineItemId of open) {
    await tx.expenseLineSignoff.create({
      data: { expenseId, lineItemId, seat: "SUBMITTER", signerUserId: signer.userId, signerUsername: signer.username },
    });
    await writeAudit(tx, signer, {
      expenseId,
      action: "signoff",
      lineItemId,
      fieldChanged: "seat",
      valueAfter: "SUBMITTER",
      notes: `confirmed the receipt as read${onBehalf} at ${confirmation.confirmedAt}`,
    });
  }
  return open.length;
}

/** Records the finance change that clears the submitter's confirmation, naming the fields it touched. */
export async function auditConfirmationVoided(tx: Prisma.TransactionClient, actor: Actor, expenseId: string, fields: string[]): Promise<void> {
  await writeAudit(tx, actor, { expenseId, action: SUBMITTER_CONFIRMATION_VOIDED, fieldChanged: fields.join(",") });
}

/**
 * A finance change to what was claimed or is paid on a reimbursement: clears the submitter seat on
 * every line and every step after it, each audited, so the person reimbursed confirms again.
 */
export async function voidSubmitterConfirmation(tx: Prisma.TransactionClient, actor: Actor, expenseId: string, fields: string[]): Promise<void> {
  await auditConfirmationVoided(tx, actor, expenseId, fields);
  await clearFrom(tx, actor, expenseId, null, "SUBMITTER", `finance changed ${fields.join(", ")}`);
}

export const submitterConfirmations: SubmitterConfirmations = {
  async awaiting() {
    const expenses = await db.expense.findMany({
      where: { orgId: await getOrgId(), ...TAKES_SUBMITTER_SEAT, reimburseePersonId: { not: null }, lineItems: { some: { signoffs: { none: { seat: "SUBMITTER" } } } } },
      select: { id: true, reimburseePersonId: true },
    });
    const voids = await db.expenseAuditLog.findMany({
      where: { expenseId: { in: expenses.map((e) => e.id) }, action: SUBMITTER_CONFIRMATION_VOIDED },
      orderBy: { id: "desc" },
      select: { expenseId: true, fieldChanged: true },
    });
    const latest = new Map<string, string[]>();
    for (const v of voids) if (!latest.has(v.expenseId)) latest.set(v.expenseId, v.fieldChanged ? v.fieldChanged.split(",") : []);
    return expenses.map((e) => ({ receiptId: e.id, reimburseePersonId: e.reimburseePersonId!, changedFields: latest.get(e.id) ?? [] }));
  },

  async confirm(receiptId, reimburseePersonId, person) {
    const signer = { userId: person.id, username: person.name };
    const result = await db.$transaction(async (tx) => {
      await lockExpense(tx, receiptId);
      const expense = await tx.expense.findFirst({ where: { id: receiptId, orgId: await getOrgId(), reimburseePersonId, ...TAKES_SUBMITTER_SEAT } });
      if (!expense) return null;
      // A Board member on the reimbursee's behalf is no party to the expense.
      if (signer.userId !== reimburseePersonId && (await conflictedParties(expense)).includes(signer.userId)) return null;
      const lines = await tx.expenseLineItem.findMany({ where: { expenseId: expense.id }, select: { id: true } });
      const signed = await recordSubmitterSeats(tx, expense.id, lines.map((l) => l.id), signer, { reimburseePersonId, confirmedAt: new Date().toISOString() });
      return signed > 0 ? expense : null;
    });
    if (!result) return false;
    if (result.state === "qb_pending" && (await unsignedLines(db, result)).size === 0) await drainExpense(result.orgId, result.id);
    return true;
  },
};
