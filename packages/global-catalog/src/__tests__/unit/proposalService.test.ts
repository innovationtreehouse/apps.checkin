import { beforeAll, expect, it } from "vitest";
import { describeDb } from "@/__tests__/helpers/db";
import { initDb, prisma } from "@/db";
import { resetDb } from "@/__tests__/helpers/db";
import {
  createItemReferenceProposal,
  approveItemReferenceProposal,
  rejectItemReferenceProposal,
} from "@/services/proposalService";
import { randomUUID } from "crypto";

beforeAll(async () => { await initDb(); });

const ORG = { orgId: "org-test-1", orgName: "Test Org" };

async function seedCatalogItem() {
  const cat = await prisma.category.create({ data: { name: `Cat-${randomUUID().slice(0, 6)}`, letter: "P" } });
  const sub = await prisma.subcategory.create({ data: { name: "Sub", number: 1, categoryId: cat.id } });
  const gtin13 = `P010000000${String(Date.now()).slice(-4)}`.slice(0, 13).padEnd(13, "0");
  await prisma.item.create({ data: {
    gtin13, name: `Item-${randomUUID().slice(0, 6)}`, categoryId: cat.id, subcategoryId: sub.id,
    sequence: 1, usageBehavior: "Durable", createdAt: new Date(), updatedAt: new Date(),
  } });
  return gtin13;
}

async function seedPendingProposal(gtin13: string, partNumber: string) {
  return prisma.itemReferenceProposal.create({ data: {
    gtin13,
    orgId: ORG.orgId,
    orgName: ORG.orgName,
    localUserId: 1,
    partNumber,
    manufacturer: "TestCo",
    conversionFactor: 1.0,
    proposedAt: new Date(),
    status: "pending",
  } });
}

// ── createItemReferenceProposal ───────────────────────────────────────────────

describeDb("createItemReferenceProposal", () => {
  it("throws 404 when the referenced item does not exist", async () => {
    await resetDb();
    await expect(
      createItemReferenceProposal({ gtin13: "9999999999999", localUserId: 1, ...ORG })
    ).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/item not found/i) });
  });

  it("creates a pending proposal for a valid item", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await createItemReferenceProposal({
      gtin13,
      localUserId: 42,
      partNumber: "PN-001",
      manufacturer: "Acme",
      ...ORG,
    });

    expect(proposal.status).toBe("pending");
    expect(proposal.gtin13).toBe(gtin13);
    expect(proposal.partNumber).toBe("PN-001");
    expect(proposal.orgId).toBe(ORG.orgId);
  });

  it("trims whitespace from string fields", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await createItemReferenceProposal({
      gtin13, localUserId: 1, partNumber: "  PN-002  ", manufacturer: "  Acme  ", ...ORG,
    });
    expect(proposal.partNumber).toBe("PN-002");
    expect(proposal.manufacturer).toBe("Acme");
  });

  it("defaults conversionFactor to 1.0 when not provided", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await createItemReferenceProposal({ gtin13, localUserId: 1, ...ORG });
    expect(proposal.conversionFactor).toBe(1.0);
  });
});

// ── approveItemReferenceProposal ──────────────────────────────────────────────

describeDb("approveItemReferenceProposal", () => {
  it("throws 404 when proposal does not exist", async () => {
    await resetDb();
    await expect(approveItemReferenceProposal(999999, 1)).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when proposal is already approved (invalid state transition)", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await seedPendingProposal(gtin13, "PN-TRANSITION");
    // First approval succeeds
    await approveItemReferenceProposal(proposal.id, 1);
    // Second approval on an already-approved proposal must fail
    await expect(approveItemReferenceProposal(proposal.id, 1)).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when proposal is already rejected (invalid state transition)", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await seedPendingProposal(gtin13, "PN-REJECT-THEN-APPROVE");
    await rejectItemReferenceProposal(proposal.id, 1, "Wrong item");
    await expect(approveItemReferenceProposal(proposal.id, 1)).rejects.toMatchObject({ status: 400 });
  });

  it("golden path: creates item reference and marks proposal approved", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await seedPendingProposal(gtin13, "PN-GOLDEN");

    await approveItemReferenceProposal(proposal.id, 99);

    const updated = await prisma.itemReferenceProposal.findFirst({ where: { id: proposal.id } });
    expect(updated?.status).toBe("approved");
    expect(updated?.reviewedByUserId).toBe(99);

    const refs = await prisma.itemReference.findMany({ where: { gtin13 } });
    expect(refs.length).toBe(1);
    expect(refs[0].partNumber).toBe("PN-GOLDEN");
  });

  it("supersedes matching pending proposals when a full partNumber+manufacturer+retailer proposal is approved", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();

    // Subset proposal (partNumber + manufacturer only) — should be superseded
    const subset = await seedPendingProposal(gtin13, "PN-SUPER");

    // Full proposal (partNumber + manufacturer + retailer)
    const full = await prisma.itemReferenceProposal.create({ data: {
      gtin13, orgId: "org-full", orgName: "Full Org", localUserId: 2,
      partNumber: "PN-SUPER", manufacturer: "TestCo", retailer: "ShopB",
      conversionFactor: 1.0, proposedAt: new Date(), status: "pending",
    } });

    await approveItemReferenceProposal(full.id, 1);

    const subsetUpdated = await prisma.itemReferenceProposal.findFirst({ where: { id: subset.id } });
    expect(subsetUpdated?.status).toBe("superseded");
    expect(subsetUpdated?.supersededByProposalId).toBe(full.id);
  });
});

// ── rejectItemReferenceProposal ───────────────────────────────────────────────

describeDb("rejectItemReferenceProposal", () => {
  it("throws 404 when proposal does not exist", async () => {
    await resetDb();
    await expect(rejectItemReferenceProposal(999999, 1, "bad")).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when proposal is already rejected", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await seedPendingProposal(gtin13, "PN-DOUBLE-REJECT");
    await rejectItemReferenceProposal(proposal.id, 1, "First rejection");
    await expect(
      rejectItemReferenceProposal(proposal.id, 1, "Second rejection")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when proposal is already approved", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await seedPendingProposal(gtin13, "PN-REJECT-APPROVED");
    await approveItemReferenceProposal(proposal.id, 1);
    await expect(
      rejectItemReferenceProposal(proposal.id, 1, "Too late")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("golden path: marks proposal rejected with reason and reviewer", async () => {
    await resetDb();
    const gtin13 = await seedCatalogItem();
    const proposal = await seedPendingProposal(gtin13, "PN-REJECT-OK");

    await rejectItemReferenceProposal(proposal.id, 77, "Wrong catalog item");

    const updated = await prisma.itemReferenceProposal.findFirst({ where: { id: proposal.id } });
    expect(updated?.status).toBe("rejected");
    expect(updated?.reviewedByUserId).toBe(77);
    expect(updated?.rejectionReason).toBe("Wrong catalog item");

    const refs = await prisma.itemReference.findMany({ where: { gtin13 } });
    expect(refs.length).toBe(0);
  });
});
