// Receipt callee: how far receiving has got with each receipt, for its uploader and reimbursee.
import { z } from "zod";
import { db } from "../db";
import { getOrgId } from "../runtime";

export type ReceivingOutcome = "waiting" | "applying" | "stuck" | "received";

const idsSchema = z.array(z.string().min(1));

const OUTCOME: Readonly<Record<string, ReceivingOutcome>> = {
  pending_review: "waiting",
  applying: "applying",
  apply_failed: "stuck",
  resolved: "received",
};

/** Each named receipt's receiving outcome; a receipt receiving never took is left out. */
export async function receivingOutcomes(receiptIds: unknown): Promise<Map<string, ReceivingOutcome>> {
  const ids = idsSchema.parse(receiptIds);
  if (ids.length === 0) return new Map();
  const rows = await db.receivedReceipt.findMany({
    where: { orgId: await getOrgId(), receiptId: { in: ids } },
    select: { receiptId: true, state: true },
  });
  return new Map(rows.map((r) => [r.receiptId, OUTCOME[r.state] ?? "stuck"]));
}
