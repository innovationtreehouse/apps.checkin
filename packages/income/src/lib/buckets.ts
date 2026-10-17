import { db } from "../db";
import type { OwnerInfo } from "../contract";
import { getIncomeConfig } from "../runtime";
import { recordAudit } from "./audit";
import { lockReconciliation } from "./reconcile";

const BUCKET_ENTITY = "budget_owner";
const UNUSABLE = "bucket.unusable";
const RESTORED = "bucket.restored";

/** Why a bucket can't take sales, or null when it can. */
export function bucketIssue(bucket: OwnerInfo | undefined, activeClassIds: ReadonlySet<string>): string | null {
  if (!bucket) return "is not in the bucket list";
  if (bucket.archivedAt) return "is archived";
  if (!bucket.quickBooksClassId) return "has no QuickBooks Class";
  if (!activeClassIds.has(bucket.quickBooksClassId)) return "has a QuickBooks Class that is not active";
  return null;
}

/** The buckets and active Classes as they stand now. Throws when either source is unbound or unreachable. */
async function bucketState(): Promise<{ buckets: OwnerInfo[]; active: Set<string> }> {
  const { owners, classes } = getIncomeConfig();
  if (!owners) throw new Error("budget-owner buckets are not connected");
  if (!classes) throw new Error("QuickBooks Classes are not connected");
  const [buckets, active] = await Promise.all([owners.list(), classes.activeClassIds()]);
  return { buckets, active: new Set(active) };
}

interface BucketCheck {
  /** Unusable assigned bucket id → reason. */
  unusable: Map<number, string>;
  itemCounts: Map<number, number>;
  names: Map<number, string>;
}

/** Check every bucket items are assigned to. Reads QuickBooks only when some item has a bucket. */
async function assess(orgId: string): Promise<BucketCheck> {
  const itemCounts = await assignedBucketItemCounts(orgId);
  const check: BucketCheck = { unusable: new Map(), itemCounts, names: new Map() };
  if (!itemCounts.size) return check;
  const { buckets, active } = await bucketState();
  const byId = new Map(buckets.map((b) => [b.id, b]));
  for (const id of itemCounts.keys()) {
    const issue = bucketIssue(byId.get(id), active);
    if (issue) check.unusable.set(id, issue);
    const name = byId.get(id)?.name;
    if (name) check.names.set(id, name);
  }
  return check;
}

/** Buckets items are assigned to that can't take sales now, with the reason. */
export async function unusableBuckets(orgId: string): Promise<Map<number, string>> {
  return (await assess(orgId)).unusable;
}

async function assignedBucketItemCounts(orgId: string): Promise<Map<number, number>> {
  const rows = await db.incomeItemCategory.groupBy({
    by: ["budgetOwnerId"],
    where: { orgId, budgetOwnerId: { not: null } },
    _count: { _all: true },
  });
  return new Map(rows.flatMap((r) => (r.budgetOwnerId === null ? [] : [[r.budgetOwnerId, r._count._all] as const])));
}

/** Buckets the last run found unusable and not yet restored, with the reason. Reads the audit log only. */
export async function openBucketIssues(orgId: string): Promise<Map<number, string>> {
  const events = await db.incomeAuditLog.findMany({
    where: { orgId, entityType: BUCKET_ENTITY, action: { in: [UNUSABLE, RESTORED] } },
    orderBy: { id: "asc" },
    select: { entityId: true, action: true, reason: true },
  });
  const open = new Map<number, string>();
  for (const e of events) {
    const id = Number(e.entityId);
    if (e.action === UNUSABLE) open.set(id, e.reason ?? "");
    else open.delete(id);
  }
  return open;
}

/**
 * The run's bucket check: alert finance once for each assigned bucket that has become
 * unusable, and record a bucket that is usable again (or no longer assigned) as restored, so
 * a later break alerts again. Returns the unusable buckets; payouts with their sales hold.
 */
export async function checkBuckets(orgId: string): Promise<Map<number, string>> {
  const alerts = getIncomeConfig().alerts;
  if (!alerts) throw new Error("income alerts are not bound");
  const [{ unusable, itemCounts, names }, open] = await Promise.all([assess(orgId), openBucketIssues(orgId)]);
  const fresh = [...unusable].filter(([id]) => !open.has(id));
  const restored = [...open.keys()].filter((id) => !unusable.has(id));
  if (!fresh.length && !restored.length) return unusable;

  await db.$transaction(async (tx) => {
    // Held with the run's lock so two runs never alert for the same bucket.
    await lockReconciliation(tx, orgId, true);
    const current = await openBucketIssues(orgId);
    for (const [id, issue] of fresh) {
      if (current.has(id)) continue;
      await alerts.bucketUnusable({ orgId, budgetOwnerId: id, bucketName: names.get(id) ?? null, issue, itemCount: itemCounts.get(id) ?? 0 });
      await recordAudit(tx, { orgId, actorUserId: null, action: UNUSABLE, entityType: BUCKET_ENTITY, entityId: id, reason: issue });
    }
    for (const id of restored) {
      if (!current.has(id)) continue;
      await recordAudit(tx, { orgId, actorUserId: null, action: RESTORED, entityType: BUCKET_ENTITY, entityId: id });
    }
  });
  return unusable;
}
