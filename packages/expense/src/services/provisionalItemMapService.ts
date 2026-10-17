import type { Db } from "../db";
import { createPartOwnerRepository } from "../repositories/partOwner";
import type { ProvisionalItemMapRepository } from "../repositories/provisionalItemMap";
import type { ProvisionalResolutionRepository } from "../repositories/provisionalResolution";

export function createProvisionalItemMapService({
  provisionalRepo,
  resolutionRepo,
  db,
}: {
  provisionalRepo: ProvisionalItemMapRepository;
  resolutionRepo: ProvisionalResolutionRepository;
  db: Db;
}) {
  const partOwners = createPartOwnerRepository(db);
  return {
    async listProvisionals(orgId: string) {
      return provisionalRepo.findManyByOrg(orgId);
    },

    /**
     * Resolution events from global-catalog never delete the provisional row —
     * work (owner assignment, expense holds, etc.) may still be in flight
     * against the provisional GTIN. We only add a new permanent mapping for
     * the resolved real GTIN and mark the provisional row resolved.
     */
    async approveProvisional(orgId: string, provisionalGtin13: string, realGtin13: string): Promise<void> {
      // Durable, idempotent record of the resolution fact FIRST — so the event is
      // never consumed-and-forgotten even when no provisional row exists yet.
      await resolutionRepo.upsert(orgId, provisionalGtin13, { kind: "approved", realGtin13 });

      const provisional = await provisionalRepo.findByGtin(orgId, provisionalGtin13);
      // No provisional row yet in this consumer — benign no-op. The fact is
      // persisted above; reconcile-on-ingest will apply it when the row appears
      // (and a provisional may legitimately never exist here).
      if (!provisional) return;
      if (provisional.status === "approved") return; // idempotent

      await this.linkRealGtin(orgId, provisionalGtin13, realGtin13);
      await provisionalRepo.updateStatus(provisional.id, {
        status: "approved",
        resolvedToGtin13: realGtin13,
        reviewedAt: new Date(),
      });
    },

    async mapProvisionalToExisting(orgId: string, provisionalGtin13: string, realGtin13: string): Promise<void> {
      await resolutionRepo.upsert(orgId, provisionalGtin13, { kind: "mapped_to_existing", realGtin13 });

      const provisional = await provisionalRepo.findByGtin(orgId, provisionalGtin13);
      if (!provisional) return; // benign no-op — fact persisted, nothing to apply yet
      if (provisional.status === "mapped_to_existing") return; // idempotent

      await this.linkRealGtin(orgId, provisionalGtin13, realGtin13);
      await provisionalRepo.updateStatus(provisional.id, {
        status: "mapped_to_existing",
        resolvedToGtin13: realGtin13,
        reviewedAt: new Date(),
      });
    },

    async rejectProvisional(orgId: string, provisionalGtin13: string, rejectionReason?: string): Promise<void> {
      await resolutionRepo.upsert(orgId, provisionalGtin13, { kind: "rejected", rejectionReason: rejectionReason ?? null });

      const provisional = await provisionalRepo.findByGtin(orgId, provisionalGtin13);
      if (!provisional) return; // benign no-op — fact persisted, nothing to apply yet
      if (provisional.status === "rejected") return; // idempotent

      await provisionalRepo.updateStatus(provisional.id, {
        status: "rejected",
        rejectionReason: rejectionReason ?? null,
        reviewedAt: new Date(),
      });
    },

    /**
     * Carries forward whatever owner is currently assigned to the provisional
     * GTIN (via partOwnerMap — the canonical, always-current source, since
     * org managers may assign/reassign owners at any point) onto the resolved
     * real GTIN. Adds a new row; never deletes the provisional mapping.
     */
    async linkRealGtin(orgId: string, provisionalGtin13: string, realGtin13: string): Promise<void> {
      const ownerId = await partOwners.resolveItemOwner(orgId, provisionalGtin13);
      if (ownerId === null) return; // no owner assigned yet — nothing to carry forward
      await partOwners.addIfAbsent(orgId, realGtin13, ownerId);
    },
  };
}

export type ProvisionalItemMapService = ReturnType<typeof createProvisionalItemMapService>;
