import type { StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { getOrgId } from "./runtime";

const FAILED = ["pipeline_failed", "push_failed", "push_refused"];

/** Receipts stuck in the flow (`flow_error`) or finalized with a failed push to mapping, timed by their latest failure audit. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const rows = await db.receipt.findMany({
    where: {
      orgId,
      OR: [
        { details: { state: "flow_error" } },
        { pushedAt: null, details: { state: "receipt_finalized" }, auditLogs: { some: { action: { in: ["push_failed", "push_refused"] } } } },
      ],
    },
    select: {
      id: true,
      details: { select: { state: true } },
      auditLogs: { where: { action: { in: FAILED } }, orderBy: { changedAt: "desc" }, take: 1, select: { changedAt: true } },
    },
  });
  return rows.flatMap((r) => {
    const last = r.auditLogs[0];
    if (!last) return [];
    return [{ id: r.id, step: r.details?.state === "flow_error" ? "flow" : "push to mapping", href: `/receipts/${r.id}`, failedAt: last.changedAt }];
  });
}
