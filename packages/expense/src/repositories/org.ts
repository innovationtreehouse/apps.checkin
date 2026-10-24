import type { Db } from "../db";
import type { ExpenseOrgSettings } from "../db/schema";

export function createOrgRepository(db: Db) {
  return {
    findByGlobalOrgId: (orgId: string) =>
      db.expenseOrgSettings.findFirst({ where: { orgId } }),

    upsert: async (orgId: string): Promise<ExpenseOrgSettings> => {
      return db.expenseOrgSettings.upsert({
        where: { orgId },
        create: { orgId },
        update: {},
      });
    },

    update: async (orgId: string, set: Partial<Omit<ExpenseOrgSettings, "orgId">>) => {
      const updated = await db.expenseOrgSettings.update({
        where: { orgId },
        data: set,
      });
      return [updated];
    },
  };
}

export type OrgRepository = ReturnType<typeof createOrgRepository>;
