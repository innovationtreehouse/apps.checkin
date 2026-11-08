import type { StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { getOrgId } from "./runtime";

/** In-kind gifts whose last QuickBooks post failed. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const rows = await db.inKindPosting.findMany({
    where: { orgId, qbFailureKind: { not: null } },
    select: { source: true, giftId: true, updatedAt: true },
  });
  return rows.map((r) => ({ id: `${r.source} ${r.giftId}`, step: "QuickBooks posting", href: `/donations/in-kind/${r.source}/${r.giftId}`, failedAt: r.updatedAt }));
}
