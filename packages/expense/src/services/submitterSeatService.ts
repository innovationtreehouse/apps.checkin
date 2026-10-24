// The reimbursement submitter's seat (Financial Policy Art. IX §IX.3). The submitter signs by
// confirming the receipt as read; the seat on each line cites that confirmation.
import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import type { SubmitterConfirmations } from "../contract";
import { writeAudit } from "../lib/audit";
import { drainExpense } from "../lib/financial-flow";
import { lockExpense, unsignedLines, voidSignoffs } from "../lib/signoff-facts";
import { CLOSED_STATES } from "../lib/signoff";
import type { Actor } from "../lib/workflow-engine";
import { getOrgId } from "../runtime";

/** The expense audit action naming the fields of a finance change that cleared the submitter's confirmation. */
export const SUBMITTER_CONFIRMATION_VOIDED = "submitter_confirmation_voided";

/** An open reimbursement that takes sign-off: the only kind with a submitter seat. */
const TAKES_SUBMITTER_SEAT = { needsReimbursement: true, backfill: false, state: { notIn: [...CLOSED_STATES] } };

/**
 * Signs the submitter seat on each given line still without one, by the submitter, each audited
 * citing the confirmation of the receipt.
 */
export async function recordSubmitterSeats(
  tx: Prisma.TransactionClient,
  expenseId: string,
  lineItemIds: number[],
  submitter: Actor,
  confirmedAt: string,
): Promise<number> {
  const signed = new Set(
    (await tx.expenseLineSignoff.findMany({ where: { expenseId, seat: "SUBMITTER" }, select: { lineItemId: true } })).map((r) => r.lineItemId),
  );
  const open = lineItemIds.filter((id) => !signed.has(id));
  for (const lineItemId of open) {
    await tx.expenseLineSignoff.create({
      data: { expenseId, lineItemId, seat: "SUBMITTER", signerUserId: submitter.userId, signerUsername: submitter.username },
    });
    await writeAudit(tx, submitter, {
      expenseId,
      action: "signoff",
      lineItemId,
      fieldChanged: "seat",
      valueAfter: "SUBMITTER",
      notes: `confirmed the receipt as read at ${confirmedAt}`,
    });
  }
  return open.length;
}

/** Records the finance change that clears the submitter's confirmation, naming the fields it touched. */
export async function auditConfirmationVoided(tx: Prisma.TransactionClient, actor: Actor, expenseId: string, fields: string[]): Promise<void> {
  await writeAudit(tx, actor, { expenseId, action: SUBMITTER_CONFIRMATION_VOIDED, fieldChanged: fields.join(",") });
}

/**
 * A finance change to what a reimbursement's submitter claimed or is paid: clears the submitter
 * seat on every line and every signature after it, each audited, so the submitter confirms again.
 */
export async function voidSubmitterConfirmation(tx: Prisma.TransactionClient, actor: Actor, expenseId: string, fields: string[]): Promise<void> {
  const reason = `finance changed ${fields.join(", ")}`;
  await auditConfirmationVoided(tx, actor, expenseId, fields);
  const seats = await tx.expenseLineSignoff.findMany({ where: { expenseId, seat: "SUBMITTER" } });
  await tx.expenseLineSignoff.deleteMany({ where: { id: { in: seats.map((s) => s.id) } } });
  for (const s of seats) {
    await writeAudit(tx, actor, { expenseId, action: "signoff_voided", lineItemId: s.lineItemId, fieldChanged: "seat", valueBefore: "SUBMITTER", notes: `signer ${s.signerUserId}: ${reason}` });
  }
  await voidSignoffs(tx, actor, expenseId, null, reason);
}

export const submitterConfirmations: SubmitterConfirmations = {
  async awaiting(personId) {
    const expenses = await db.expense.findMany({
      where: { orgId: await getOrgId(), submitterId: personId, ...TAKES_SUBMITTER_SEAT, lineItems: { some: { signoffs: { none: { seat: "SUBMITTER" } } } } },
      select: { id: true },
    });
    const voids = await db.expenseAuditLog.findMany({
      where: { expenseId: { in: expenses.map((e) => e.id) }, action: SUBMITTER_CONFIRMATION_VOIDED },
      orderBy: { id: "desc" },
      select: { expenseId: true, fieldChanged: true },
    });
    const latest = new Map<string, string[]>();
    for (const v of voids) if (!latest.has(v.expenseId)) latest.set(v.expenseId, v.fieldChanged ? v.fieldChanged.split(",") : []);
    return new Map(expenses.map((e) => [e.id, latest.get(e.id) ?? []]));
  },

  async confirm(receiptId, person) {
    const submitter = { userId: person.id, username: person.name };
    const result = await db.$transaction(async (tx) => {
      await lockExpense(tx, receiptId);
      const expense = await tx.expense.findFirst({ where: { id: receiptId, orgId: await getOrgId(), submitterId: person.id, ...TAKES_SUBMITTER_SEAT } });
      if (!expense) return null;
      const lines = await tx.expenseLineItem.findMany({ where: { expenseId: expense.id }, select: { id: true } });
      const signed = await recordSubmitterSeats(tx, expense.id, lines.map((l) => l.id), submitter, new Date().toISOString());
      return signed > 0 ? expense : null;
    });
    if (!result) return false;
    if (result.state === "qb_pending" && (await unsignedLines(db, result)).size === 0) await drainExpense(result.orgId, result.id);
    return true;
  },
};
