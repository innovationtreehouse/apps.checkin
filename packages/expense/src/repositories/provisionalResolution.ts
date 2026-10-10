import type { Db } from "../db";
import type { ExpenseProvisionalResolution } from "../db/schema";

export interface ProvisionalResolutionData {
  kind: string; // "approved" | "mapped_to_existing" | "rejected"
  realGtin13?: string | null;
  rejectionReason?: string | null;
  sourceEventId?: number | null;
}

export function createProvisionalResolutionRepository(db: Db) {
  return {
    /**
     * Durable, idempotent record of a catalog S5 resolution fact, keyed on
     * (orgId, provisionalGtin13). Persisted regardless of whether a provisional
     * row yet exists in this consumer, so a later ingest can reconcile against
     * it. The update branch refreshes to the LATEST fact.
     *
     * These apps have a known non-atomic-upsert race: a concurrent insert can
     * surface a P2002 on the unique key. We tolerate it by re-reading.
     */
    async upsert(
      orgId: string,
      provisionalGtin13: string,
      data: ProvisionalResolutionData,
    ): Promise<ExpenseProvisionalResolution> {
      const payload = {
        kind: data.kind,
        realGtin13: data.realGtin13 ?? null,
        rejectionReason: data.rejectionReason ?? null,
        sourceEventId: data.sourceEventId ?? null,
      };
      try {
        return await db.expenseProvisionalResolution.upsert({
          where: { provisional_resolution_org_gtin_unique: { orgId, provisionalGtin13 } },
          create: { orgId, provisionalGtin13, ...payload },
          update: { ...payload, recordedAt: new Date() },
        });
      } catch (err) {
        // P2002 unique race: another writer inserted concurrently. Re-read and
        // apply the latest fact via update so the record still converges.
        if (isUniqueRace(err)) {
          return db.expenseProvisionalResolution.update({
            where: { provisional_resolution_org_gtin_unique: { orgId, provisionalGtin13 } },
            data: { ...payload, recordedAt: new Date() },
          });
        }
        throw err;
      }
    },

    async findByGtin(orgId: string, provisionalGtin13: string): Promise<ExpenseProvisionalResolution | null> {
      return db.expenseProvisionalResolution.findFirst({
        where: { orgId, provisionalGtin13 },
      });
    },
  };
}

function isUniqueRace(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export type ProvisionalResolutionRepository = ReturnType<typeof createProvisionalResolutionRepository>;
