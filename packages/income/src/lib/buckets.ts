import { db } from "../db";
import type { OwnerInfo } from "../contract";
import { getIncomeConfig } from "../runtime";
import { recordAudit } from "./audit";
import { lockReconciliation } from "./reconcile";

const BUCKET_ENTITY = "budget_owner";
const UNUSABLE = "bucket.unusable";
const RESTORED = "bucket.restored";
const UNSENT = "bucket.alert_unsent";

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

/** Why an assigned bucket can't take sales right now, or undefined when it can. */
export type BucketProblem = (bucketId: number) => string | undefined;

/** Every bucket's problem while the buckets or their Classes can't be read. */
export const UNCHECKED = "can't be checked: QuickBooks Classes can't be read";

interface BucketCheck {
  /** Unusable assigned bucket id → reason. Null while the buckets or Classes can't be read. */
  unusable: Map<number, string> | null;
  itemCounts: Map<number, number>;
  names: Map<number, string>;
}

/** Check every bucket items are assigned to. Reads QuickBooks only when some item has a bucket. */
async function assess(orgId: string): Promise<BucketCheck> {
  const itemCounts = await assignedBucketItemCounts(orgId);
  const check: BucketCheck = { unusable: new Map(), itemCounts, names: new Map() };
  if (!itemCounts.size) return check;
  let state: Awaited<ReturnType<typeof bucketState>>;
  try {
    state = await bucketState();
  } catch {
    return { ...check, unusable: null };
  }
  const byId = new Map(state.buckets.map((b) => [b.id, b]));
  for (const id of itemCounts.keys()) {
    const issue = bucketIssue(byId.get(id), state.active);
    if (issue) check.unusable?.set(id, issue);
    const name = byId.get(id)?.name;
    if (name) check.names.set(id, name);
  }
  return check;
}

const problemOf = (unusable: Map<number, string> | null): BucketProblem =>
  unusable ? (id) => unusable.get(id) : () => UNCHECKED;

/** Problems of the buckets items are assigned to, as they stand now. */
export async function bucketProblems(orgId: string): Promise<BucketProblem> {
  return problemOf((await assess(orgId)).unusable);
}

async function assignedBucketItemCounts(orgId: string): Promise<Map<number, number>> {
  const rows = await db.incomeItemCategory.groupBy({
    by: ["budgetOwnerId"],
    where: { orgId, budgetOwnerId: { not: null } },
    _count: { _all: true },
  });
  return new Map(rows.flatMap((r) => (r.budgetOwnerId === null ? [] : [[r.budgetOwnerId, r._count._all] as const])));
}

/** Buckets the last run found unusable and not yet restored, with the reason, and those whose alert was not sent. Reads the audit log only. */
async function bucketEvents(orgId: string): Promise<{ open: Map<number, string>; unsent: Set<number> }> {
  const events = await db.incomeAuditLog.findMany({
    where: { orgId, entityType: BUCKET_ENTITY, action: { in: [UNUSABLE, RESTORED, UNSENT] } },
    orderBy: { id: "asc" },
    select: { entityId: true, action: true, reason: true },
  });
  const open = new Map<number, string>();
  const unsent = new Set<number>();
  for (const e of events) {
    const id = Number(e.entityId);
    if (e.action === UNSENT) {
      unsent.add(id);
      continue;
    }
    unsent.delete(id);
    if (e.action === UNUSABLE) open.set(id, e.reason ?? "");
    else open.delete(id);
  }
  return { open, unsent };
}

/** Buckets the last run found unusable and not yet restored, with the reason. Reads the audit log only. */
export async function openBucketIssues(orgId: string): Promise<Map<number, string>> {
  return (await bucketEvents(orgId)).open;
}

/** Buckets whose break still needs an alert: newly unusable, or recorded but not alerted. */
const toAlert = (unusable: Map<number, string>, { open, unsent }: Awaited<ReturnType<typeof bucketEvents>>) =>
  [...unusable].filter(([id]) => !open.has(id) || unsent.has(id));

/**
 * The run's bucket check: alert finance once for each assigned bucket that has become
 * unusable, and record a bucket that is usable again (or no longer assigned) as restored, so
 * a later break alerts again. While the Classes can't be read nothing is recorded and every
 * bucket reports UNCHECKED, so only payouts with a bucketed sale hold.
 */
export async function checkBuckets(orgId: string): Promise<BucketProblem> {
  const alerts = getIncomeConfig().alerts;
  if (!alerts) throw new Error("income alerts are not bound");
  const [{ unusable, itemCounts, names }, events] = await Promise.all([assess(orgId), bucketEvents(orgId)]);
  if (!unusable) return problemOf(null);
  const fresh = toAlert(unusable, events);
  const restored = [...events.open.keys()].filter((id) => !unusable.has(id));
  if (!fresh.length && !restored.length) return problemOf(unusable);

  const recorded = await db.$transaction(async (tx) => {
    // Held with the run's lock so two runs never record the same bucket.
    await lockReconciliation(tx, orgId, true);
    const current = await bucketEvents(orgId);
    const newly = toAlert(new Map(fresh), current);
    for (const [id, issue] of newly) {
      await recordAudit(tx, { orgId, actorUserId: null, action: UNUSABLE, entityType: BUCKET_ENTITY, entityId: id, reason: issue });
    }
    for (const id of restored.filter((r) => current.open.has(r))) {
      await recordAudit(tx, { orgId, actorUserId: null, action: RESTORED, entityType: BUCKET_ENTITY, entityId: id });
    }
    return newly;
  });
  // Sent after commit, outside the lock; a bucket whose alert is not sent is alerted again by the next run.
  const sent = await Promise.allSettled(
    recorded.map(([id, issue]) =>
      alerts.bucketUnusable({ orgId, budgetOwnerId: id, bucketName: names.get(id) ?? null, issue, itemCount: itemCounts.get(id) ?? 0 }),
    ),
  );
  const unsent = recorded.filter((_, i) => {
    const r = sent[i];
    return r.status === "rejected" || !r.value;
  });
  for (const [id] of unsent) {
    await recordAudit(db, { orgId, actorUserId: null, action: UNSENT, entityType: BUCKET_ENTITY, entityId: id });
  }
  return problemOf(unusable);
}
