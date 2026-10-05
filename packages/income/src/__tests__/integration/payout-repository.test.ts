import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { createPayoutRepository } from "../../repositories/payout";
import { clearAll, seedPayout, seedConflict, ORG_A, ORG_B, newUserId } from "../helpers/fixtures";

const repo = createPayoutRepository(db);

beforeEach(async () => {
  await clearAll();
});

// ── listPayouts ────────────────────────────────────────────────────────────────

describeDb("listPayouts", () => {
  it("returns payouts for the given org", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-05-01", totalCents: 9700 });
    const rows = await repo.listPayouts(ORG_A, 1, 25);
    expect(rows).toHaveLength(1);
    expect(rows[0].payoutDate).toBe("2026-05-01");
    expect(rows[0].totalCents).toBe(9700);
  });

  it("does not return payouts from other orgs", async () => {
    await seedPayout(ORG_B, { payoutDate: "2026-05-01" });
    const rows = await repo.listPayouts(ORG_A, 1, 25);
    expect(rows).toHaveLength(0);
  });

  it("orders by payoutDate descending", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-05-01", totalCents: 9700 });
    await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 5000 });
    const rows = await repo.listPayouts(ORG_A, 1, 25);
    expect(rows[0].payoutDate).toBe("2026-06-01");
    expect(rows[1].payoutDate).toBe("2026-05-01");
  });

  it("paginates with offset", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-05-01", totalCents: 9700 });
    await seedPayout(ORG_A, { payoutDate: "2026-06-01", totalCents: 5000 });
    const page2 = await repo.listPayouts(ORG_A, 2, 1);
    expect(page2).toHaveLength(1);
    expect(page2[0].payoutDate).toBe("2026-05-01");
  });

  it("returns empty array when no payouts", async () => {
    const rows = await repo.listPayouts(ORG_A, 1, 25);
    expect(rows).toHaveLength(0);
  });
});

// ── countPayouts ───────────────────────────────────────────────────────────────

describeDb("countPayouts", () => {
  it("returns 0 when no payouts", async () => {
    const [{ total }] = await repo.countPayouts(ORG_A);
    expect(total).toBe(0);
  });

  it("counts payouts for org only", async () => {
    await seedPayout(ORG_A);
    await seedPayout(ORG_A, { payoutDate: "2026-06-01" });
    await seedPayout(ORG_B);
    const [{ total }] = await repo.countPayouts(ORG_A);
    expect(total).toBe(2);
  });
});

// ── findPayoutById ─────────────────────────────────────────────────────────────

describeDb("findPayoutById", () => {
  it("returns the payout when id and orgId match", async () => {
    const id = await seedPayout(ORG_A, { bankReference: "REF-X" });
    const rows = await repo.findPayoutById(ORG_A, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].bankReference).toBe("REF-X");
  });

  it("returns empty when orgId does not match", async () => {
    const id = await seedPayout(ORG_A);
    const rows = await repo.findPayoutById(ORG_B, id);
    expect(rows).toHaveLength(0);
  });

  it("returns empty when id does not exist", async () => {
    const rows = await repo.findPayoutById(ORG_A, 99999);
    expect(rows).toHaveLength(0);
  });
});

// ── listPendingConflicts ───────────────────────────────────────────────────────

describeDb("listPendingConflicts", () => {
  it("returns pending conflicts for the org", async () => {
    const importId = await seedPayout(ORG_A);
    await seedConflict(ORG_A, importId);
    const rows = await repo.listPendingConflicts(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].reason).toBe("payload_mismatch");
  });

  it("does not return conflicts from other orgs", async () => {
    const importId = await seedPayout(ORG_B);
    await seedConflict(ORG_B, importId);
    const rows = await repo.listPendingConflicts(ORG_A);
    expect(rows).toHaveLength(0);
  });

  it("returns empty when no pending conflicts", async () => {
    const rows = await repo.listPendingConflicts(ORG_A);
    expect(rows).toHaveLength(0);
  });
});

// ── findConflictById ───────────────────────────────────────────────────────────

describeDb("findConflictById", () => {
  it("finds conflict by id (any org)", async () => {
    const importId = await seedPayout(ORG_A);
    const conflictId = await seedConflict(ORG_A, importId);
    const rows = await repo.findConflictById(conflictId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(conflictId);
  });

  it("returns empty for nonexistent id", async () => {
    const rows = await repo.findConflictById(99999);
    expect(rows).toHaveLength(0);
  });
});

// ── resolveConflict ────────────────────────────────────────────────────────────

describeDb("resolveConflict", () => {
  it("sets status to accepted with resolver info", async () => {
    const importId = await seedPayout(ORG_A);
    const conflictId = await seedConflict(ORG_A, importId);
    const userId = newUserId();

    await repo.resolveConflict(conflictId, "accepted", userId);

    const rows = await repo.findConflictById(conflictId);
    expect(rows[0].status).toBe("accepted");
    expect(rows[0].resolvedByUserId).toBe(userId);
    expect(rows[0].resolvedAt).toBeDefined();
  });

  it("sets status to rejected", async () => {
    const importId = await seedPayout(ORG_A);
    const conflictId = await seedConflict(ORG_A, importId);

    await repo.resolveConflict(conflictId, "rejected", newUserId());

    const rows = await repo.findConflictById(conflictId);
    expect(rows[0].status).toBe("rejected");
  });

  it("does not appear in listPendingConflicts after resolution", async () => {
    const importId = await seedPayout(ORG_A);
    const conflictId = await seedConflict(ORG_A, importId);
    await repo.resolveConflict(conflictId, "accepted", newUserId());
    const pending = await repo.listPendingConflicts(ORG_A);
    expect(pending).toHaveLength(0);
  });
});

// ── insertImport / insertPayout ────────────────────────────────────────────────

describeDb("insertImport and insertPayout", () => {
  it("insertImport returns the new record with autoincrement id", async () => {
    const [imp] = await repo.insertImport({
      orgId: ORG_A,
      payoutDate: "2026-05-01",
      totalCents: 9700,
      payload: JSON.stringify({ source: "shopify" }),
    });
    expect(imp.id).toBeGreaterThan(0);
    expect(imp.orgId).toBe(ORG_A);
  });

  it("insertPayout stores all numeric fields", async () => {
    const [imp] = await repo.insertImport({
      orgId: ORG_A, payoutDate: "2026-05-01", totalCents: 9700, payload: "{}",
    });
    await repo.insertPayout({
      id: imp.id, orgId: ORG_A, payoutDate: "2026-05-01", status: "paid",
      chargesCents: 10000, refundsCents: 0, adjustmentsCents: 0, marketplaceSalesTaxCents: 0,
      advancesCents: 0, reservedFundsCents: 0, feesCents: -300, retriedAmountCents: 0,
      totalCents: 9700, currency: "USD", bankReference: "REF-1",
    });

    const rows = await repo.findPayoutById(ORG_A, imp.id);
    expect(rows[0].chargesCents).toBe(10000);
    expect(rows[0].feesCents).toBe(-300);
    expect(rows[0].currency).toBe("USD");
  });
});
