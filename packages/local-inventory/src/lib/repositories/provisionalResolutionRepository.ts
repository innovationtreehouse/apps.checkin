import type { Db } from "../db/index";
import { isUniqueConstraintError } from "../db/index";
import type { InventoryProvisionalResolution } from "../db/schema";

export interface ProvisionalResolutionInput {
  kind: string; // "approved" | "mapped_to_existing" | "rejected"
  realGtin13?: string | null;
  rejectionReason?: string | null;
  sourceEventId?: number | null;
}

export function createProvisionalResolutionRepository(db: Db) {
  return {
    /**
     * Durably record (or re-record) the catalog resolution for a provisional GTIN, keyed on
     * the (orgId, provisionalGtin13) compound unique. Idempotent: a repeat delivery updates
     * the same row. Tolerates a P2002 create-race by re-reading the winning row.
     */
    async upsert(
      orgId: string,
      provisionalGtin13: string,
      data: ProvisionalResolutionInput,
    ): Promise<InventoryProvisionalResolution> {
      const payload = {
        kind: data.kind,
        realGtin13: data.realGtin13 ?? null,
        rejectionReason: data.rejectionReason ?? null,
        sourceEventId: data.sourceEventId ?? null,
      };
      try {
        return await db.inventoryProvisionalResolution.upsert({
          where: { provisional_resolution_org_gtin_unique: { orgId, provisionalGtin13 } },
          create: { orgId, provisionalGtin13, ...payload },
          update: payload,
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          // Lost the create race — the row now exists; the winning upsert already
          // persisted an equivalent record, so re-read and return it.
          const existing = await this.findByGtin(orgId, provisionalGtin13);
          if (existing) return existing;
        }
        throw err;
      }
    },

    async findByGtin(
      orgId: string,
      provisionalGtin13: string,
    ): Promise<InventoryProvisionalResolution | null> {
      return db.inventoryProvisionalResolution.findFirst({
        where: { orgId, provisionalGtin13 },
      });
    },
  };
}

export type ProvisionalResolutionRepository = ReturnType<typeof createProvisionalResolutionRepository>;
