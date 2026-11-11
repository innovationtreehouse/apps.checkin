// Counts for the host's receipt flow status page: raw org-wide totals, not the queue badges.
import { db } from "../db";
import { receivedReceiptStateEnum } from "../db/schema";
import { STATE_LABEL } from "../lib/stateLabels";
import { getOrgId } from "../runtime";

export interface ReceivingStateCount {
  state: string;
  label: string;
  count: number;
}

/** One count per receiving state, zeros included, then any stored state the enum does not define. */
export function tallyReceivingStates(rows: readonly { state: string; _count: { _all: number } }[]): ReceivingStateCount[] {
  const known: readonly string[] = receivedReceiptStateEnum;
  const counts = new Map(rows.map((r) => [r.state, r._count._all]));
  const unknown = [...counts.keys()].filter((s) => !known.includes(s));
  return [...known, ...unknown].map((state) => ({ state, label: STATE_LABEL[state] ?? state, count: counts.get(state) ?? 0 }));
}

/** How many of the org's received receipts sit in each state. */
export async function receivingStateCounts(): Promise<ReceivingStateCount[]> {
  const rows = await db.receivedReceipt.groupBy({
    by: ["state"],
    where: { orgId: await getOrgId() },
    _count: { _all: true },
  });
  return tallyReceivingStates(rows);
}
