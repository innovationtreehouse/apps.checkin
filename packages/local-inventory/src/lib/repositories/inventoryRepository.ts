import type { Prisma } from "../../generated/prisma/client";
import type { Db } from "../db/index";
import type { OrgItem, InventoryLog } from "../db/schema";

type EnrichedOrgItem = OrgItem & { location: string | null; backstockLocation: string | null };

function toEnriched(
  item: OrgItem & { location: { name: string } | null; backstockLocation: { name: string } | null },
): EnrichedOrgItem {
  return {
    ...item,
    location: item.location?.name ?? null,
    backstockLocation: item.backstockLocation?.name ?? null,
  };
}

const enrichedInclude = {
  location: true,
  backstockLocation: true,
} as const;

export function createInventoryRepository(db: Db) {
  return {
    async findManyByOrg(orgId: string): Promise<EnrichedOrgItem[]> {
      const rows = await db.orgItem.findMany({
        where: { orgId },
        orderBy: { gtin13: "asc" },
        include: enrichedInclude,
      });
      return rows.map(toEnriched);
    },

    async findOneEnriched(orgId: string, gtin13: string): Promise<EnrichedOrgItem | null> {
      const row = await db.orgItem.findFirst({
        where: { orgId, gtin13 },
        include: enrichedInclude,
      });
      return row ? toEnriched(row) : null;
    },

    async findOne(orgId: string, gtin13: string): Promise<OrgItem | null> {
      return db.orgItem.findFirst({ where: { orgId, gtin13 } });
    },

    async create(data: Prisma.OrgItemCreateInput): Promise<OrgItem> {
      return db.orgItem.create({ data });
    },

    async update(orgId: string, gtin13: string, data: Prisma.OrgItemUpdateInput): Promise<void> {
      await db.orgItem.update({ where: { orgGtin: { orgId, gtin13 } }, data });
    },

    async delete(orgId: string, gtin13: string): Promise<void> {
      await db.orgItem.delete({ where: { orgGtin: { orgId, gtin13 } } });
    },

    async logChange(entry: Prisma.InventoryLogCreateInput): Promise<void> {
      await db.inventoryLog.create({ data: entry });
    },

    async findLog(orgId: string): Promise<InventoryLog[]> {
      return db.inventoryLog.findMany({
        where: { orgId },
        orderBy: { changedAt: "asc" },
      });
    },
  };
}

export type InventoryRepository = ReturnType<typeof createInventoryRepository>;
