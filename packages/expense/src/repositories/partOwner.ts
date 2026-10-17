import type { Db } from "../db";

/** Bucket per GTIN: finance's standing map from a part to the budget-owner bucket that owns it. */
export function createPartOwnerRepository(db: Db) {
  return {
    listForOrg: (orgId: string) => db.partOwnerMap.findMany({ where: { orgId } }),

    async resolveItemOwner(orgId: string, gtin13: string): Promise<number | null> {
      const row = await db.partOwnerMap.findFirst({ where: { orgId, gtin13 } });
      return row?.ownerId ?? null;
    },

    async updateItemOwner(orgId: string, gtin13: string, ownerId: number): Promise<void> {
      await db.partOwnerMap.upsert({
        where: { part_owner_map_org_gtin_unique: { orgId, gtin13 } },
        create: { orgId, gtin13, ownerId },
        update: { ownerId },
      });
    },

    /** Adds the mapping unless the GTIN already has one; safe inside a transaction. */
    async addIfAbsent(orgId: string, gtin13: string, ownerId: number): Promise<void> {
      await db.partOwnerMap.createMany({ data: [{ orgId, gtin13, ownerId }], skipDuplicates: true });
    },
  };
}

export type PartOwnerRepository = ReturnType<typeof createPartOwnerRepository>;
