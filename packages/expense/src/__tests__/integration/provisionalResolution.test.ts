/**
 * Focused tests for the durable ProvisionalResolution record + the
 * reconcile-on-ingest convergence helper, in isolation from the poller/route.
 *
 * Uses the real (throwaway-Postgres) DB harness — same `db` + `describeDb` gate
 * as the other integration-tier suites, since the resolution upsert and the
 * service reconcile both hit Prisma.
 */
import { it, expect } from "vitest";
import { db } from "../../db";
import { describeDb } from "../helpers/db";
import { createProvisionalItemMapRepository } from "../../repositories/provisionalItemMap";
import { createProvisionalResolutionRepository } from "../../repositories/provisionalResolution";
import { createProvisionalItemMapService } from "../../services/provisionalItemMapService";
import { ORG } from "../helpers/seed";

const provisionalRepo = createProvisionalItemMapRepository(db);
const resolutionRepo = createProvisionalResolutionRepository(db);
const service = createProvisionalItemMapService({ provisionalRepo, resolutionRepo, db });

// ── resolution-record upsert ────────────────────────────────────────────────

describeDb("provisionalResolutionRepository.upsert", () => {
  it("creates a new resolution record keyed on (orgId, provisionalGtin13)", async () => {
    await resolutionRepo.upsert(ORG, "R-CREATE", { kind: "approved", realGtin13: "REAL-CREATE" });
    const rec = await resolutionRepo.findByGtin(ORG, "R-CREATE");
    expect(rec?.kind).toBe("approved");
    expect(rec?.realGtin13).toBe("REAL-CREATE");
    expect(rec?.rejectionReason).toBeNull();
  });

  it("is idempotent on the unique key and refreshes to the latest fact", async () => {
    await resolutionRepo.upsert(ORG, "R-UPSERT", { kind: "approved", realGtin13: "REAL-A" });
    await resolutionRepo.upsert(ORG, "R-UPSERT", { kind: "mapped_to_existing", realGtin13: "REAL-B" });

    const all = await db.expenseProvisionalResolution.findMany({ where: { orgId: ORG, provisionalGtin13: "R-UPSERT" } });
    expect(all).toHaveLength(1); // single row, not duplicated
    expect(all[0].kind).toBe("mapped_to_existing");
    expect(all[0].realGtin13).toBe("REAL-B");
  });

  it("records a rejection with its reason", async () => {
    await resolutionRepo.upsert(ORG, "R-REJ", { kind: "rejected", rejectionReason: "duplicate" });
    const rec = await resolutionRepo.findByGtin(ORG, "R-REJ");
    expect(rec?.kind).toBe("rejected");
    expect(rec?.rejectionReason).toBe("duplicate");
    expect(rec?.realGtin13).toBeNull();
  });

  it("scopes by org — same gtin in two orgs is two distinct records", async () => {
    await resolutionRepo.upsert(ORG, "R-SCOPE", { kind: "approved", realGtin13: "REAL-1" });
    await resolutionRepo.upsert("org-other", "R-SCOPE", { kind: "rejected" });
    expect((await resolutionRepo.findByGtin(ORG, "R-SCOPE"))?.kind).toBe("approved");
    expect((await resolutionRepo.findByGtin("org-other", "R-SCOPE"))?.kind).toBe("rejected");
  });
});

// ── event-first persists, apply is a benign no-op without a provisional row ──

describeDb("resolution event before provisional row exists", () => {
  it("approveProvisional records the fact and does not create a provisional row", async () => {
    await service.approveProvisional(ORG, "R-EVENT-FIRST", "REAL-EF");
    expect(await provisionalRepo.findByGtin(ORG, "R-EVENT-FIRST")).toBeNull();
    const rec = await resolutionRepo.findByGtin(ORG, "R-EVENT-FIRST");
    expect(rec?.kind).toBe("approved");
    expect(rec?.realGtin13).toBe("REAL-EF");
  });
});

// ── reconcile-on-ingest convergence helper (mirrors route.ts logic) ──────────

/**
 * Mirrors the reconcile loop in src/app/api/expenses/route.ts: after a pending
 * provisional row is created, look up the resolution fact and apply it via the
 * idempotent service methods.
 */
async function reconcile(orgId: string, gtin: string) {
  const resolution = await resolutionRepo.findByGtin(orgId, gtin);
  if (!resolution) return;
  switch (resolution.kind) {
    case "approved":
      if (resolution.realGtin13) await service.approveProvisional(orgId, gtin, resolution.realGtin13);
      break;
    case "mapped_to_existing":
      if (resolution.realGtin13) await service.mapProvisionalToExisting(orgId, gtin, resolution.realGtin13);
      break;
    case "rejected":
      await service.rejectProvisional(orgId, gtin, resolution.rejectionReason ?? undefined);
      break;
  }
}

describeDb("reconcile-on-ingest helper", () => {
  it("converges a freshly-created pending provisional to the recorded real GTIN (approved)", async () => {
    await service.approveProvisional(ORG, "R-RECON-APPROVE", "REAL-RA"); // event first
    await provisionalRepo.create({ orgId: ORG, provisionalGtin13: "R-RECON-APPROVE", proposedAt: new Date() });

    await reconcile(ORG, "R-RECON-APPROVE");

    const prov = await provisionalRepo.findByGtin(ORG, "R-RECON-APPROVE");
    expect(prov?.status).toBe("approved");
    expect(prov?.resolvedToGtin13).toBe("REAL-RA");
  });

  it("converges to mapped_to_existing", async () => {
    await service.mapProvisionalToExisting(ORG, "R-RECON-MAP", "REAL-RM");
    await provisionalRepo.create({ orgId: ORG, provisionalGtin13: "R-RECON-MAP", proposedAt: new Date() });

    await reconcile(ORG, "R-RECON-MAP");

    const prov = await provisionalRepo.findByGtin(ORG, "R-RECON-MAP");
    expect(prov?.status).toBe("mapped_to_existing");
    expect(prov?.resolvedToGtin13).toBe("REAL-RM");
  });

  it("converges to rejected with the recorded reason", async () => {
    await service.rejectProvisional(ORG, "R-RECON-REJ", "bad part");
    await provisionalRepo.create({ orgId: ORG, provisionalGtin13: "R-RECON-REJ", proposedAt: new Date() });

    await reconcile(ORG, "R-RECON-REJ");

    const prov = await provisionalRepo.findByGtin(ORG, "R-RECON-REJ");
    expect(prov?.status).toBe("rejected");
    expect(prov?.rejectionReason).toBe("bad part");
  });

  it("is a no-op when no resolution fact exists (row stays pending)", async () => {
    await provisionalRepo.create({ orgId: ORG, provisionalGtin13: "R-RECON-NONE", proposedAt: new Date() });
    await reconcile(ORG, "R-RECON-NONE");
    const prov = await provisionalRepo.findByGtin(ORG, "R-RECON-NONE");
    expect(prov?.status).toBe("pending");
    expect(prov?.resolvedToGtin13).toBeNull();
  });

  it("re-running reconcile is idempotent", async () => {
    await service.approveProvisional(ORG, "R-RECON-IDEM", "REAL-RI");
    await provisionalRepo.create({ orgId: ORG, provisionalGtin13: "R-RECON-IDEM", proposedAt: new Date() });
    await reconcile(ORG, "R-RECON-IDEM");
    await reconcile(ORG, "R-RECON-IDEM");
    const prov = await provisionalRepo.findByGtin(ORG, "R-RECON-IDEM");
    expect(prov?.status).toBe("approved");
    expect(prov?.resolvedToGtin13).toBe("REAL-RI");
  });
});
