// Receipt callee: how far receiving has got with each receipt, for its uploader and reimbursee.
import { z } from "zod";
import { db } from "../db";
import { getOrgId } from "../runtime";
import { openBackorders } from "./receiptService";

export type ReceivingOutcome = "waiting" | "applying" | "stuck" | "received";

const idsSchema = z.array(z.string().min(1));

const OUTCOME: Readonly<Record<string, ReceivingOutcome>> = {
  pending_review: "waiting",
  applying: "applying",
  apply_failed: "stuck",
  resolved: "received",
};

/** Each named receipt's receiving outcome and its lines still open on the receive queue; a receipt receiving never took is left out. */
export async function receivingOutcomes(receiptIds: unknown): Promise<Map<string, { receiving: ReceivingOutcome; openBackorders: number }>> {
  const ids = idsSchema.parse(receiptIds);
  if (ids.length === 0) return new Map();
  const rows = await db.receivedReceipt.findMany({
    where: { orgId: await getOrgId(), receiptId: { in: ids } },
    select: { receiptId: true, state: true },
  });
  const backorders = await openBackorders(rows);
  return new Map(rows.map((r) => [r.receiptId, { receiving: OUTCOME[r.state] ?? "stuck", openBackorders: backorders.get(r.receiptId) ?? 0 }]));
}
