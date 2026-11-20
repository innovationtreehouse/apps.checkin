import { db } from "../db";
import { getOrgId } from "../runtime";
import { CLOSED_STATES } from "../lib/signoff";

/** One kind of unfinished work that still needs a bucket, in finance's words, with the page finance moves it from. */
export interface BucketUse {
  what: string;
  count: number;
  where: string;
}

/** What in the expense library still needs bucket `id`, one line per kind; empty when nothing does. */
export async function unfinishedBucketUses(id: number): Promise<BucketUse[]> {
  const orgId = await getOrgId();
  const [lines, parts] = await Promise.all([
    db.expenseLineItem.count({ where: { expense: { orgId, state: { notIn: [...CLOSED_STATES] } }, approvals: { some: { ownerId: id } } } }),
    db.partOwnerMap.count({ where: { orgId, ownerId: id } }),
  ]);
  return [
    { what: "open expense lines", count: lines, where: "Finance › Expenses" },
    { what: "parts mapped to it for future receipts", count: parts, where: "Finance › Part Buckets" },
  ].filter((use) => use.count > 0);
}
