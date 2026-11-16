import { db } from "../db";
import { getOrgId } from "../runtime";
import { SETTLED_STATUSES } from "../lib/reconcile";
import { DEPOSIT_SOURCE } from "../lib/sources";
import { expectedOf } from "../lib/intake";

/** One kind of unfinished work that still needs a bucket, in finance's words, with the page finance moves it from. */
export interface BucketUse {
  what: string;
  count: number;
  where: string;
}

/** What in the income library still needs bucket `id`, one line per kind; empty when nothing does. */
export async function unfinishedBucketUses(id: number): Promise<BucketUse[]> {
  const orgId = await getOrgId();
  const [items, deposits] = await Promise.all([
    db.incomeItemCategory.count({ where: { orgId, budgetOwnerId: id } }),
    db.payoutReconciliation.findMany({
      where: { orgId, source: DEPOSIT_SOURCE.BENEVITY, status: { notIn: SETTLED_STATUSES } },
      select: { expected: true },
    }),
  ]);
  const unposted = deposits.filter((row) => expectedOf(row)?.lines.some((line) => line.budgetOwnerId === id)).length;
  return [
    { what: "store items mapped to it", count: items, where: "Income › Item Categories" },
    { what: "Benevity deposits not yet posted", count: unposted, where: "Income › Reconciliation" },
  ].filter((use) => use.count > 0);
}
