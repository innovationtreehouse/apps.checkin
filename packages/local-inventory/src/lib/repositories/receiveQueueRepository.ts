import type { Prisma } from "../../generated/prisma/client";
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

  };
}

export type ReceiveQueueRepository = ReturnType<typeof createReceiveQueueRepository>;
