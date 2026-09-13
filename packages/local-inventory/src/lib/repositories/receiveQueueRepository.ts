import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "../db/index";
import type { ReceiveQueue } from "../db/schema";

export function createReceiveQueueRepository(db: Db) {
  return {
    async findManyByOrg(orgId: string): Promise<ReceiveQueue[]> {
      return db.receiveQueue.findMany({
        where: { orgId },
        orderBy: { queuedAt: "asc" },
      });
    },

    async findOne(id: number, orgId: string): Promise<ReceiveQueue | null> {
      return db.receiveQueue.findFirst({ where: { id, orgId } });
    },

    async create(data: Prisma.ReceiveQueueCreateInput): Promise<ReceiveQueue> {
      return db.receiveQueue.create({ data });
    },

    async markFulfilled(id: number): Promise<ReceiveQueue> {
      return db.receiveQueue.update({
        where: { id },
        data: { fulfilledAt: new Date() },
      });
    },

    async delete(id: number): Promise<void> {
      await db.receiveQueue.delete({ where: { id } });
    },
  };
}

export type ReceiveQueueRepository = ReturnType<typeof createReceiveQueueRepository>;
