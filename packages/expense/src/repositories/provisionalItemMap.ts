import type { Db } from "../db";
import type { ProvisionalItemMap, NewProvisionalItemMap } from "../db/schema";

export function createProvisionalItemMapRepository(db: Db) {
  return {
    async findByGtin(orgId: string, provisionalGtin13: string): Promise<ProvisionalItemMap | null> {
      return db.provisionalItemMap.findFirst({
        where: { orgId, provisionalGtin13 },
      });
    },

    async findManyByOrg(orgId: string): Promise<ProvisionalItemMap[]> {
      return db.provisionalItemMap.findMany({
        where: { orgId },
        orderBy: { proposedAt: "desc" },
      });
    },

    async create(data: NewProvisionalItemMap): Promise<ProvisionalItemMap> {
      return db.provisionalItemMap.create({ data });
    },

    async updateStatus(id: number, data: Partial<NewProvisionalItemMap>) {
      await db.provisionalItemMap.update({ where: { id }, data });
    },
  };
}

export type ProvisionalItemMapRepository = ReturnType<typeof createProvisionalItemMapRepository>;
