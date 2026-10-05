import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { createPayoutDetailRepository } from "../../repositories/payout-detail";
import { clearAll, seedPayout, ORG_A, ORG_B, newUserId } from "../helpers/fixtures";

const repo = createPayoutDetailRepository(db);

beforeEach(async () => {
  await clearAll();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedImportFile(orgId: string) {
  return db.payoutDetailImportFile.create({
    data: {
      orgId,
      uploadedByUserId: newUserId(),
      originalFilename: "transactions.csv",
      fileHash: Math.random().toString(36),
      rowCount: 1,
      insertedCount: 1,
      duplicateCount: 0,
    },
  });
}

async function seedDetailBlob(orgId: string, shopifyPayoutId: string, payoutDate = "2026-05-01") {
  const importFile = await seedImportFile(orgId);
  const blob = await db.shopifyPayoutDetailBlob.create({
    data: {
      orgId,
      shopifyPayoutId,
      payoutDate,
      payload: JSON.stringify({ shopifyPayoutId }),
      importFileId: importFile.id,
    },
  });
  return { blob, importFile };
}

async function seedLineItem(orgId: string, shopifyPayoutId: string) {
  return db.shopifyPayoutLineItem.create({
    data: {
      orgId,
      shopifyPayoutId,
      transactionDate: "2026-05-01",
      transactionType: "charge",
      payoutDate: "2026-05-01",
      amountCents: 10000,
      feeCents: -300,
      netCents: 9700,
      currency: "USD",
    },
  });
}

// ── findBlobByPayoutId ─────────────────────────────────────────────────────────

describeDb("findBlobByPayoutId", () => {
  it("returns the blob when orgId and shopifyPayoutId match", async () => {
    await seedDetailBlob(ORG_A, "SP-001");
    const rows = await repo.findBlobByPayoutId(ORG_A, "SP-001");
    expect(rows).toHaveLength(1);
    expect(rows[0].shopifyPayoutId).toBe("SP-001");
  });

  it("returns empty when orgId does not match", async () => {
    await seedDetailBlob(ORG_A, "SP-001");
    const rows = await repo.findBlobByPayoutId(ORG_B, "SP-001");
    expect(rows).toHaveLength(0);
  });

  it("returns empty when shopifyPayoutId does not match", async () => {
    await seedDetailBlob(ORG_A, "SP-001");
    const rows = await repo.findBlobByPayoutId(ORG_A, "SP-NONE");
    expect(rows).toHaveLength(0);
  });
});

// ── listLineItemsByPayoutId ────────────────────────────────────────────────────

describeDb("listLineItemsByPayoutId", () => {
  it("returns line items for matching org and payout id", async () => {
    await seedLineItem(ORG_A, "SP-001");
    await seedLineItem(ORG_A, "SP-001");
    const items = await repo.listLineItemsByPayoutId(ORG_A, "SP-001");
    expect(items).toHaveLength(2);
    expect(items[0].transactionType).toBe("charge");
  });

  it("does not return items from other orgs", async () => {
    await seedLineItem(ORG_B, "SP-001");
    const items = await repo.listLineItemsByPayoutId(ORG_A, "SP-001");
    expect(items).toHaveLength(0);
  });

  it("does not return items for different payout id", async () => {
    await seedLineItem(ORG_A, "SP-001");
    const items = await repo.listLineItemsByPayoutId(ORG_A, "SP-002");
    expect(items).toHaveLength(0);
  });

  it("returns empty array when no items", async () => {
    const items = await repo.listLineItemsByPayoutId(ORG_A, "SP-NONE");
    expect(items).toHaveLength(0);
  });
});

// ── listImportFiles ────────────────────────────────────────────────────────────

describeDb("listImportFiles", () => {
  it("returns import files for org ordered by uploadedAt desc", async () => {
    await seedImportFile(ORG_A);
    await seedImportFile(ORG_A);
    const files = await repo.listImportFiles(ORG_A);
    expect(files).toHaveLength(2);
  });

  it("does not return files from other orgs", async () => {
    await seedImportFile(ORG_B);
    const files = await repo.listImportFiles(ORG_A);
    expect(files).toHaveLength(0);
  });
});

// ── listPayoutsWithoutDetail ───────────────────────────────────────────────────

describeDb("listPayoutsWithoutDetail", () => {
  it("returns payouts where shopifyPayoutId is null", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-05-01" });
    const rows = await repo.listPayoutsWithoutDetail(ORG_A);
    expect(rows).toHaveLength(1);
  });

  it("does not return payouts from other orgs", async () => {
    await seedPayout(ORG_B);
    const rows = await repo.listPayoutsWithoutDetail(ORG_A);
    expect(rows).toHaveLength(0);
  });

  it("returns empty when no unmatched payouts", async () => {
    const rows = await repo.listPayoutsWithoutDetail(ORG_A);
    expect(rows).toHaveLength(0);
  });
});

// ── listDetailBlobsWithoutPayout ───────────────────────────────────────────────

describeDb("listDetailBlobsWithoutPayout", () => {
  it("returns detail blobs that have no matching payout", async () => {
    await seedDetailBlob(ORG_A, "SP-ORPHAN");
    const rows = await repo.listDetailBlobsWithoutPayout(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].shopifyPayoutId).toBe("SP-ORPHAN");
  });

  it("does not return blobs from other orgs", async () => {
    await seedDetailBlob(ORG_B, "SP-001");
    const rows = await repo.listDetailBlobsWithoutPayout(ORG_A);
    expect(rows).toHaveLength(0);
  });

  it("counts line items for each blob", async () => {
    await seedDetailBlob(ORG_A, "SP-001");
    await seedLineItem(ORG_A, "SP-001");
    await seedLineItem(ORG_A, "SP-001");
    const rows = await repo.listDetailBlobsWithoutPayout(ORG_A);
    expect(rows[0].lineCount).toBe(2);
  });
});
