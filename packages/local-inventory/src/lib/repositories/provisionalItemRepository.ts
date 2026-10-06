import type { Prisma } from "../../generated/prisma/client";
import type { Db } from "../db/index";
import type { InventoryProvisionalItem, InventoryMergeConflict, ProvisionalItemLog } from "../db/schema";

export function createProvisionalItemRepository(db: Db) {
  return {
    async findByGtin(orgId: string, gtin13: string): Promise<InventoryProvisionalItem | null> {
      return db.inventoryProvisionalItem.findFirst({
        where: { provisionalGtin13: gtin13, orgId },
      });
    },

    async findManyByOrg(orgId: string): Promise<InventoryProvisionalItem[]> {
      return db.inventoryProvisionalItem.findMany({
        where: { orgId },
        orderBy: { proposedAt: "desc" },
      });
    },

    async create(data: Prisma.InventoryProvisionalItemCreateInput): Promise<InventoryProvisionalItem> {
      return db.inventoryProvisionalItem.create({ data });
    },

    async updateStatus(id: number, data: Prisma.InventoryProvisionalItemUpdateInput): Promise<void> {
      await db.inventoryProvisionalItem.update({ where: { id }, data });
    },

    async createConflict(data: Prisma.InventoryMergeConflictCreateInput): Promise<void> {
      await db.inventoryMergeConflict.upsert({
        where: { sourceEventId: data.sourceEventId as number },
        create: data,
        update: {},
      });
    },

    async findConflictsByOrg(orgId: string): Promise<InventoryMergeConflict[]> {
      return db.inventoryMergeConflict.findMany({
        where: { orgId },
        orderBy: { id: "desc" },
      });
    },

    async findConflict(id: number, orgId: string): Promise<InventoryMergeConflict | null> {
      return db.inventoryMergeConflict.findFirst({ where: { id, orgId } });
    },

    async updateConflict(id: number, data: Prisma.InventoryMergeConflictUpdateInput): Promise<void> {
      await db.inventoryMergeConflict.update({ where: { id }, data });
    },

    async logEvent(entry: Prisma.ProvisionalItemLogCreateInput): Promise<ProvisionalItemLog> {
      return db.provisionalItemLog.create({ data: entry });
    },
  };
}

export type ProvisionalItemRepository = ReturnType<typeof createProvisionalItemRepository>;
