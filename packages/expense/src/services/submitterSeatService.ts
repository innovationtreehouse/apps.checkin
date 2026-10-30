// The reimbursement submitter's seat (Financial Policy Art. IX §IX.3). The person reimbursed signs
// by confirming the receipt as read, or a Board member does on behalf of one with no account; the
// seat on each line cites that confirmation.
import type { Expense, Prisma } from "../generated/prisma/client";
import { db, type Db } from "../db";
import type { SubmitterConfirmations } from "../contract";
import { writeAudit } from "../lib/audit";
import { drainExpense } from "../lib/financial-flow";
import { clearFrom, filledSeatsByLine, lockExpense, signoffFactsByLine, unsignedLines } from "../lib/signoff-facts";
import { CLOSED_STATES, submitterSeatRefusal } from "../lib/signoff";
import { ServiceError } from "@checkin/component-kit";
import type { Actor } from "../lib/workflow-engine";
import { getOrgId } from "../runtime";

/** The expense audit action naming the fields of a finance change that cleared the submitter's confirmation. */
export const SUBMITTER_CONFIRMATION_VOIDED = "submitter_confirmation_voided";

/** An open reimbursement that takes sign-off: the only kind with a submitter seat. */
const TAKES_SUBMITTER_SEAT = { needsReimbursement: true, backfill: false, state: { notIn: [...CLOSED_STATES] } };

/**
 * Signs the submitter seat on each given line still without one, by `signer`: the person
 * reimbursed, or a Board member on their behalf with their reason. Each is audited citing the
 * confirmation.
 */
export async function recordSubmitterSeats(
  tx: Prisma.TransactionClient,
  expenseId: string,
  lineItemIds: number[],
  signer: Actor,
  confirmation: { reimburseePersonId: number; confirmedAt: string; reason?: string | null },
): Promise<number> {
  const signed = new Set(
    (await tx.expenseLineSignoff.findMany({ where: { expenseId, seat: "SUBMITTER" }, select: { lineItemId: true } })).map((r) => r.lineItemId),
  );
  const onBehalf = signer.userId === confirmation.reimburseePersonId ? "" : ` on behalf of ${confirmation.reimburseePersonId}`;
  const reason = onBehalf && confirmation.reason ? `: ${confirmation.reason}` : "";
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
      notes: `confirmed the receipt as read${onBehalf} at ${confirmation.confirmedAt}${reason}`,
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

/**
 * The lines of an expense still waiting for the submitter seat, and why `signerUserId` may not
 * sign one of them, or null.
 */
async function waitingSeats(client: Db, expense: Expense, signerUserId: number, readOnly = false): Promise<{ waiting: number[]; refusal: string | null }> {
  const [facts, filled] = await Promise.all([signoffFactsByLine(client, expense, { readOnly }), filledSeatsByLine(client, expense.id)]);
  const waiting = [...facts.keys()].filter((id) => !(filled.get(id) ?? []).some((f) => f.seat === "SUBMITTER"));
  for (const id of waiting) {
    const refusal = submitterSeatRefusal(facts.get(id)!, filled.get(id) ?? [], signerUserId);
    if (refusal) return { waiting, refusal };
  }
  return { waiting, refusal: null };
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

  async confirm(receiptId, reimburseePersonId, person, reason) {
    const signer = { userId: person.id, username: person.name };
    const result = await db.$transaction(async (tx) => {
      await lockExpense(tx, receiptId);
      const expense = await tx.expense.findFirst({ where: { id: receiptId, orgId: await getOrgId(), reimburseePersonId, ...TAKES_SUBMITTER_SEAT } });
      if (!expense) return null;
      // Each line still waiting takes the seat's own refusals, read under the expense lock.
      const { waiting, refusal } = await waitingSeats(tx, expense, signer.userId);
      if (refusal) throw new ServiceError(403, refusal);
      const signed = await recordSubmitterSeats(tx, expense.id, waiting, signer, { reimburseePersonId, confirmedAt: new Date().toISOString(), reason });
      return signed > 0 ? expense : null;
    });
    if (!result) return false;
    if (result.state === "qb_pending" && (await unsignedLines(db, result)).size === 0) await drainExpense(result.orgId, result.id);
    return true;
  },

  async confirmable(receiptIds, signerUserId) {
    if (receiptIds.length === 0) return [];
    const expenses = await db.expense.findMany({ where: { id: { in: receiptIds }, orgId: await getOrgId(), ...TAKES_SUBMITTER_SEAT } });
    const out: string[] = [];
    for (const expense of expenses) {
      const { waiting, refusal } = await waitingSeats(db, expense, signerUserId, true);
      if (waiting.length > 0 && !refusal) out.push(expense.id);
    }
    return out;
  },
};
