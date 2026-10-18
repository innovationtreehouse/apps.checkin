import { db } from "../db";
import { getIncomeConfig } from "../runtime";
import { recordAudit } from "../lib/audit";
import { ServiceError } from "@checkin/component-kit";
import { bucketIssue, openBucketIssues } from "../lib/buckets";
import type { Actor } from "./reconciliationService";

/**
 * Finance's decision for an item: a bucket, general income (a mapping with no bucket), or
 * undecided (no mapping). A payout with an undecided item's sale waits until finance decides.
 */
export type ItemDecision = "bucket" | "general" | "undecided";

/** A variant the mirror has seen, with the org's decision for it. */
export interface IncomeItem {
  variantId: string;
  title: string;
  sku: string | null;
  decision: ItemDecision;
  budgetOwnerId: number | null;
  budgetOwnerName: string | null;
  /** Why the item's bucket can't take sales, as the last run found it; its payouts wait. */
  bucketIssue: string | null;
}

export const itemCategoryService = {
  /** Every item the mirror has seen, plus mapped items it no longer reports. */
  async listItems(orgId: string): Promise<IncomeItem[]> {
    const mirror = getIncomeConfig().mirror;
    const [seen, mappings, buckets, issues] = await Promise.all([
      mirror ? mirror.itemsSeen() : [],
      db.incomeItemCategory.findMany({ where: { orgId } }),
      getIncomeConfig().owners?.list() ?? [],
      openBucketIssues(orgId),
    ]);
    const bucketName = new Map(buckets.map((b) => [b.id, b.name]));
    const mapped = new Map(mappings.map((m) => [m.variantId, m.budgetOwnerId]));
    const blank = { decision: "undecided" as const, budgetOwnerId: null, budgetOwnerName: null, bucketIssue: null };
    const items: IncomeItem[] = seen.map((s) => ({ ...s, ...blank }));
    const seenIds = new Set(seen.map((s) => s.variantId));
    for (const m of mappings) {
      if (!seenIds.has(m.variantId)) items.push({ variantId: m.variantId, title: "", sku: null, ...blank });
    }
    for (const item of items) {
      const ownerId = mapped.get(item.variantId);
      if (ownerId === undefined) continue;
      item.decision = ownerId === null ? "general" : "bucket";
      item.budgetOwnerId = ownerId;
      item.budgetOwnerName = ownerId === null ? null : (bucketName.get(ownerId) ?? null);
      item.bucketIssue = ownerId === null ? null : (issues.get(ownerId) ?? null);
    }
    return items.sort((a, b) => a.title.localeCompare(b.title) || a.variantId.localeCompare(b.variantId));
  },

  /**
   * Book an item to a bucket, or to general income (null), from now on; deposits already
   * created are never rebooked. A bucket must be live with an active QuickBooks Class, checked
   * against QuickBooks now: while QuickBooks can't be reached the assignment is refused.
   */
  async setCategory(orgId: string, variantId: string, budgetOwnerId: number | null, actor: Actor) {
    if (budgetOwnerId !== null) {
      const { owners, classes } = getIncomeConfig();
      if (!owners) throw new ServiceError(503, "Budget-owner buckets are not connected");
      const bucket = (await owners.list()).find((b) => b.id === budgetOwnerId);
      if (!bucket) throw new ServiceError(422, "Unknown budget-owner bucket");
      if (bucket.archivedAt || !bucket.quickBooksClassId) {
        throw new ServiceError(422, `Budget-owner bucket ${bucketIssue(bucket, new Set())}`);
      }
      if (!classes) throw new ServiceError(503, "QuickBooks Classes are not connected, so no item can be assigned to a bucket");
      let active: string[];
      try {
        active = await classes.activeClassIds();
      } catch {
        throw new ServiceError(503, "QuickBooks can't be reached to check the bucket's Class; try again later");
      }
      const issue = bucketIssue(bucket, new Set(active));
      if (issue) throw new ServiceError(422, `Budget-owner bucket ${issue}`);
    }

    return db.$transaction(async (tx) => {
      const before = await tx.incomeItemCategory.findUnique({ where: { orgId_variantId: { orgId, variantId } } });
      const saved = await tx.incomeItemCategory.upsert({
        where: { orgId_variantId: { orgId, variantId } },
        create: { orgId, variantId, budgetOwnerId },
        update: { budgetOwnerId },
      });
      await recordAudit(tx, {
        orgId,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        action: "item_category.set",
        entityType: "income_item_category",
        entityId: saved.id,
        before: before ?? undefined,
        after: saved,
      });
      return saved;
    });
  },

  /** Remove finance's decision: the item is undecided again, and payouts with its sales wait. */
  async clearCategory(orgId: string, variantId: string, actor: Actor) {
    return db.$transaction(async (tx) => {
      const before = await tx.incomeItemCategory.findUnique({ where: { orgId_variantId: { orgId, variantId } } });
      if (!before) throw new ServiceError(404, "Item has no category");
      await tx.incomeItemCategory.delete({ where: { id: before.id } });
      await recordAudit(tx, {
        orgId,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        action: "item_category.cleared",
        entityType: "income_item_category",
        entityId: before.id,
        before,
      });
      return before;
    });
  },
};
