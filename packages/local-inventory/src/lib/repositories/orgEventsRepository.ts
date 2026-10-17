import type { Prisma } from "../../generated/prisma/client";
import type { Db } from "../db/index";
import type { InventoryReceivedOrgEvent, ReceivedOrgEventStatus } from "../db/schema";

export function createOrgEventsRepository(db: Db) {
  return {
    async getMaxId(): Promise<number> {
      const result = await db.inventoryReceivedOrgEvent.aggregate({ _max: { id: true } });
      return result._max.id ?? 0;
    },

    /** Ids already received (any status) above `afterId`. */
    async idsAfter(afterId: number): Promise<number[]> {
      const rows = await db.inventoryReceivedOrgEvent.findMany({ where: { id: { gt: afterId } }, select: { id: true } });
      return rows.map((r) => r.id);
    },

    async findOne(id: number): Promise<InventoryReceivedOrgEvent | null> {
      return db.inventoryReceivedOrgEvent.findFirst({ where: { id } });
    },

    async exists(id: number): Promise<boolean> {
      const row = await db.inventoryReceivedOrgEvent.findFirst({ where: { id } });
      return row != null;
    },

    async insert(data: Prisma.InventoryReceivedOrgEventCreateInput): Promise<void> {
      await db.inventoryReceivedOrgEvent.create({ data });
    },

    async updateStatus(id: number, status: ReceivedOrgEventStatus, failureReason?: string | null): Promise<void> {
      await db.inventoryReceivedOrgEvent.update({
        where: { id },
        data: { status, failureReason: failureReason ?? null },
      });
    },

    async findPending(orgId: string): Promise<InventoryReceivedOrgEvent[]> {
      return db.inventoryReceivedOrgEvent.findMany({
        where: {
          orgId,
          OR: [{ status: "pending" }, { status: "failed" }],
        },
        orderBy: { id: "asc" },
      });
    },

    async findMany(orgId: string): Promise<InventoryReceivedOrgEvent[]> {
      return db.inventoryReceivedOrgEvent.findMany({
        where: { orgId },
        orderBy: { id: "asc" },
      });
    },
  };
}

export type OrgEventsRepository = ReturnType<typeof createOrgEventsRepository>;
