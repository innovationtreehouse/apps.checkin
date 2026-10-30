// Counts for the host's receipt flow status page: raw org-wide totals, not a queue or a viewer's share.
import { db } from "../db";
import { STATE_LABELS } from "../lib/stateLabels";
import { getOrg } from "../runtime";
import { receiptMachine } from "../workflows/receipt.machine";

export interface ReceiptStateCount {
  state: string;
  label: string;
  count: number;
}

/** Every state the receipt machine defines, in its order. */
export const RECEIPT_STATES: readonly string[] = Object.keys(receiptMachine.config.states ?? {});

/** One count per machine state, zeros included, then any stored state the machine does not define. */
export function tallyReceiptStates(rows: readonly { state: string; _count: { _all: number } }[]): ReceiptStateCount[] {
  const counts = new Map(rows.map((r) => [r.state, r._count._all]));
  const unknown = [...counts.keys()].filter((s) => !RECEIPT_STATES.includes(s));
  return [...RECEIPT_STATES, ...unknown].map((state) => ({ state, label: STATE_LABELS[state] ?? state, count: counts.get(state) ?? 0 }));
}

/** How many of the org's receipts sit in each state, and how many finalized ones receiving has not yet received. */
export async function receiptStateCounts(): Promise<{ states: ReceiptStateCount[]; notDelivered: number }> {
  const orgId = (await getOrg()).id;
  const [rows, notDelivered] = await Promise.all([
    db.receiptDetail.groupBy({ by: ["state"], where: { orgId }, _count: { _all: true } }),
    db.receipt.count({ where: { orgId, pushedAt: null, details: { state: "receipt_finalized" } } }),
  ]);
  return { states: tallyReceiptStates(rows), notDelivered };
}
