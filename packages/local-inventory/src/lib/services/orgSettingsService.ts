import type { Db } from "../db/index";
import type { InventorySettingsData } from "../db/schema";

export function createOrgSettingsService({ db }: { db: Db }) {
  return {
    async getConfig(): Promise<InventorySettingsData> {
      const row = await db.inventorySettingsData.findFirst({ where: { id: 1 } });
      return row ?? {
        id: 1,
        globalServerUrl: null,
        pollIntervalMinutes: 3,
        pollWindowStart: "00:00",
        pollWindowEnd: "23:59",
      };
    },

    async updateConfig(data: {
      globalServerUrl?: string | null;
      pollIntervalMinutes: number;
      pollWindowStart: string;
      pollWindowEnd: string;
    }): Promise<InventorySettingsData> {
      return db.inventorySettingsData.upsert({
        where: { id: 1 },
        create: { id: 1, ...data },
        update: data,
      });
    },
  };
}

export type OrgSettingsService = ReturnType<typeof createOrgSettingsService>;
