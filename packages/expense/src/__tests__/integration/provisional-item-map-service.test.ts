/**
 * Unit tests for createProvisionalItemMapService.
 *
 * Uses real in-memory DB and real repositories (same approach as qb-processor
 * tests). Covers approve, map-to-existing, reject, and the linkRealGtin
 * owner-carry-forward logic.
 */
import { it, expect, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { createProvisionalItemMapRepository } from "../../repositories/provisionalItemMap";
import { createProvisionalResolutionRepository } from "../../repositories/provisionalResolution";
import { createProvisionalItemMapService } from "../../services/provisionalItemMapService";
import { ORG } from "../helpers/seed";

const provisionalRepo = createProvisionalItemMapRepository(db);
const resolutionRepo = createProvisionalResolutionRepository(db);
const service = createProvisionalItemMapService({ provisionalRepo, resolutionRepo, db });

async function createProv(gtin: string, orgId = ORG) {
  return provisionalRepo.create({ orgId, provisionalGtin13: gtin, proposedAt: new Date() });
}

async function assignOwner(gtin: string, ownerId: number, orgId = ORG) {
  await db.partOwnerMap.create({ data: { orgId, gtin13: gtin, ownerId } });
}

async function ownerOf(gtin: string, orgId = ORG): Promise<number | null> {
  const row = await db.partOwnerMap.findFirst({ where: { orgId, gtin13: gtin } });
  return row?.ownerId ?? null;
}

// ── listProvisionals ──────────────────────────────────────────────────────────

describeDb("listProvisionals", () => {
  it("returns all provisionals for the org", async () => {
    await createProv("P-001");
    await createProv("P-002");
    const results = await service.listProvisionals(ORG);
    const gtins = results.map((r) => r.provisionalGtin13);
    expect(gtins).toContain("P-001");
    expect(gtins).toContain("P-002");
  });
});

// ── approveProvisional ────────────────────────────────────────────────────────

describeDb("approveProvisional", () => {
  it("marks the provisional as approved and links the real GTIN", async () => {
    await createProv("P-ORIG");
    await approveAndCheck("P-ORIG", "REAL-001", "approved");
  });

  it("carries the provisional owner over to the real GTIN", async () => {
    await createProv("P-WITH-OWNER");
    await assignOwner("P-WITH-OWNER", 42);

    await service.approveProvisional(ORG, "P-WITH-OWNER", "REAL-002");

    expect(await ownerOf("REAL-002")).toBe(42);
    expect(await ownerOf("P-WITH-OWNER")).toBe(42);
  });

  it("does NOT create a real GTIN mapping when no owner is assigned", async () => {
    await createProv("P-NO-OWNER");
    await service.approveProvisional(ORG, "P-NO-OWNER", "REAL-003");
    expect(await ownerOf("REAL-003")).toBeNull();
  });

  it("is idempotent — second call on already-approved gtin is a no-op", async () => {
    await createProv("P-IDEM");
    await service.approveProvisional(ORG, "P-IDEM", "REAL-004");
    await service.approveProvisional(ORG, "P-IDEM", "REAL-004");
    const prov = await provisionalRepo.findByGtin(ORG, "P-IDEM");
    expect(prov?.status).toBe("approved");
  });

  it("for an unknown provisional GTIN, durably records the resolution fact without throwing (no provisional row yet)", async () => {
    await service.approveProvisional(ORG, "NONEXISTENT", "REAL-005");
    // No provisional row exists — nothing to apply.
    expect(await provisionalRepo.findByGtin(ORG, "NONEXISTENT")).toBeNull();
    // But the resolution fact is persisted so a later ingest can reconcile.
    const resolution = await resolutionRepo.findByGtin(ORG, "NONEXISTENT");
    expect(resolution?.kind).toBe("approved");
    expect(resolution?.realGtin13).toBe("REAL-005");
  });
});

// ── mapProvisionalToExisting ──────────────────────────────────────────────────

describeDb("mapProvisionalToExisting", () => {
  it("marks provisional as mapped_to_existing and links real GTIN", async () => {
    await createProv("P-MAP");
    await assignOwner("P-MAP", 11);
    await service.mapProvisionalToExisting(ORG, "P-MAP", "REAL-010");
    const prov = await provisionalRepo.findByGtin(ORG, "P-MAP");
    expect(prov?.status).toBe("mapped_to_existing");
    expect(await ownerOf("REAL-010")).toBe(11);
  });

  it("is idempotent — second call is a no-op", async () => {
    await createProv("P-MAP-IDEM");
    await service.mapProvisionalToExisting(ORG, "P-MAP-IDEM", "REAL-011");
    await service.mapProvisionalToExisting(ORG, "P-MAP-IDEM", "REAL-011");
    const prov = await provisionalRepo.findByGtin(ORG, "P-MAP-IDEM");
    expect(prov?.status).toBe("mapped_to_existing");
  });
});

// ── rejectProvisional ─────────────────────────────────────────────────────────

describeDb("rejectProvisional", () => {
  it("marks the provisional as rejected with a reason", async () => {
    await createProv("P-REJ");
    await service.rejectProvisional(ORG, "P-REJ", "duplicate entry");
    const prov = await provisionalRepo.findByGtin(ORG, "P-REJ");
    expect(prov?.status).toBe("rejected");
    expect(prov?.rejectionReason).toBe("duplicate entry");
  });

  it("rejects without a reason (reason is null)", async () => {
    await createProv("P-REJ-NO-REASON");
    await service.rejectProvisional(ORG, "P-REJ-NO-REASON");
    const prov = await provisionalRepo.findByGtin(ORG, "P-REJ-NO-REASON");
    expect(prov?.status).toBe("rejected");
    expect(prov?.rejectionReason).toBeNull();
  });

  it("is idempotent — second call on already-rejected gtin is a no-op", async () => {
    await createProv("P-REJ-IDEM");
    await service.rejectProvisional(ORG, "P-REJ-IDEM", "first reason");
    await service.rejectProvisional(ORG, "P-REJ-IDEM", "second reason");
    const prov = await provisionalRepo.findByGtin(ORG, "P-REJ-IDEM");
    expect(prov?.rejectionReason).toBe("first reason");
  });
});

// ── Cross-org isolation ───────────────────────────────────────────────────────

describeDb("cross-org isolation", () => {
  const OTHER_ORG = "org-other";

  it("approveProvisional does not touch a provisional belonging to a different org", async () => {
    await createProv("P-CROSS", OTHER_ORG);
    // Call with ORG, but the provisional was created under OTHER_ORG
    await service.approveProvisional(ORG, "P-CROSS", "REAL-CROSS");
    // The OTHER_ORG provisional must be untouched (it stays pending)
    const prov = await provisionalRepo.findByGtin(OTHER_ORG, "P-CROSS");
    expect(prov?.status).toBe("pending");
    // The resolution fact is scoped to the queried org, not OTHER_ORG
    expect(await resolutionRepo.findByGtin(OTHER_ORG, "P-CROSS")).toBeNull();
  });

  it("rejectProvisional does not touch a provisional belonging to a different org", async () => {
    await createProv("P-REJ-CROSS", OTHER_ORG);
    await service.rejectProvisional(ORG, "P-REJ-CROSS", "wrong org reject");
    const prov = await provisionalRepo.findByGtin(OTHER_ORG, "P-REJ-CROSS");
    expect(prov?.status).toBe("pending");
    expect(await resolutionRepo.findByGtin(OTHER_ORG, "P-REJ-CROSS")).toBeNull();
  });
});

// ── State-transition guard gaps ───────────────────────────────────────────────

describeDb("approveProvisional — guard gaps", () => {
  it("second approve call with a different realGtin does not overwrite resolvedToGtin13", async () => {
    await createProv("P-GUARD");
    await service.approveProvisional(ORG, "P-GUARD", "REAL-FIRST");
    await service.approveProvisional(ORG, "P-GUARD", "REAL-SECOND"); // should be no-op
    const prov = await provisionalRepo.findByGtin(ORG, "P-GUARD");
    expect(prov?.resolvedToGtin13).toBe("REAL-FIRST");
  });
});

describeDb("rejectProvisional — guard gaps", () => {
  it("rejecting an already-approved provisional updates status to rejected (documents current permissive behavior)", async () => {
    await createProv("P-APPROV-THEN-REJ");
    await service.approveProvisional(ORG, "P-APPROV-THEN-REJ", "REAL-ATR");
    // Current code only guards against re-reject, not against rejecting an approved entry.
    await service.rejectProvisional(ORG, "P-APPROV-THEN-REJ", "changed mind");
    const prov = await provisionalRepo.findByGtin(ORG, "P-APPROV-THEN-REJ");
    // Document current behavior: status is overwritten to rejected.
    expect(prov?.status).toBe("rejected");
  });
});

// ── linkRealGtin ──────────────────────────────────────────────────────────────

describeDb("linkRealGtin", () => {
  it("copies the owner from the provisional to the real GTIN mapping", async () => {
    await assignOwner("P-LINK", 77);
    await service.linkRealGtin(ORG, "P-LINK", "REAL-LINK");
    expect(await ownerOf("REAL-LINK")).toBe(77);
  });

  it("does not overwrite an existing real GTIN mapping (onConflictDoNothing)", async () => {
    await assignOwner("P-LINK2", 55);
    await assignOwner("REAL-LINK2", 99);
    await service.linkRealGtin(ORG, "P-LINK2", "REAL-LINK2");
    expect(await ownerOf("REAL-LINK2")).toBe(99);
  });

  it("is a no-op when no owner is assigned to the provisional", async () => {
    await service.linkRealGtin(ORG, "P-UNOWNED", "REAL-UNOWNED");
    expect(await ownerOf("REAL-UNOWNED")).toBeNull();
  });
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function approveAndCheck(provGtin: string, realGtin: string, expectedStatus: string) {
  await service.approveProvisional(ORG, provGtin, realGtin);
  const prov = await provisionalRepo.findByGtin(ORG, provGtin);
  expect(prov?.status).toBe(expectedStatus);
  expect(prov?.resolvedToGtin13).toBe(realGtin);
}
