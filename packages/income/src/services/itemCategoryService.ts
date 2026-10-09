import { db } from "../db";
import { getIncomeConfig } from "../runtime";
import { recordAudit } from "../lib/audit";
import { ServiceError } from "./serviceError";
import type { Actor } from "./reconciliationService";

/** A variant the mirror has seen, with the org's bucket mapping (null = organization level). */
export interface IncomeItem {
  variantId: string;
  title: string;
  sku: string | null;
  budgetOwnerId: number | null;
  budgetOwnerName: string | null;
}

async function owners() {
  const directory = getIncomeConfig().owners;
  if (!directory) throw new ServiceError(503, "Budget-owner buckets are not connected");
  return directory.list();
}

export const itemCategoryService = {
  /** Every item the mirror has seen, plus mapped items it no longer reports. */
  async listItems(orgId: string): Promise<IncomeItem[]> {
    const mirror = getIncomeConfig().mirror;
    const [seen, mappings, buckets] = await Promise.all([
      mirror ? mirror.itemsSeen() : [],
      db.incomeItemCategory.findMany({ where: { orgId } }),
      getIncomeConfig().owners?.list() ?? [],
    ]);
    const bucketName = new Map(buckets.map((b) => [b.id, b.name]));
    const mapped = new Map(mappings.map((m) => [m.variantId, m.budgetOwnerId]));
    const items: IncomeItem[] = seen.map((s) => ({ ...s, budgetOwnerId: null, budgetOwnerName: null }));
    const seenIds = new Set(seen.map((s) => s.variantId));
    for (const m of mappings) {
      if (!seenIds.has(m.variantId)) items.push({ variantId: m.variantId, title: "", sku: null, budgetOwnerId: null, budgetOwnerName: null });
    }
    for (const item of items) {
      const ownerId = mapped.get(item.variantId);
      if (ownerId !== undefined) {
        item.budgetOwnerId = ownerId;
        item.budgetOwnerName = bucketName.get(ownerId) ?? null;
      }
    }
    return items.sort((a, b) => a.title.localeCompare(b.title) || a.variantId.localeCompare(b.variantId));
  },

  /** Book an item to an active bucket from now on; deposits already created are never rebooked. */
  async setCategory(orgId: string, variantId: string, budgetOwnerId: number, actor: Actor) {
    const bucket = (await owners()).find((b) => b.id === budgetOwnerId);
    if (!bucket) throw new ServiceError(422, "Unknown budget-owner bucket");
    if (bucket.archivedAt) throw new ServiceError(422, "Budget-owner bucket is archived");

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

  /** Return an item to organization level. */
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
