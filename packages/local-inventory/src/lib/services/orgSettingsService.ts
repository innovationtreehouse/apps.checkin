import type { Db } from "../db/index";
import type { SettingsData } from "../db/schema";

export function createOrgSettingsService({ db }: { db: Db }) {
  return {
    async getConfig(): Promise<SettingsData> {
      const row = await db.settingsData.findFirst({ where: { id: 1 } });
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
    }): Promise<SettingsData> {
      return db.settingsData.upsert({
        where: { id: 1 },
        create: { id: 1, ...data },
        update: data,
      });
    },
  };
}

export type OrgSettingsService = ReturnType<typeof createOrgSettingsService>;
