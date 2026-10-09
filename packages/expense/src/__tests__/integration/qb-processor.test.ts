/**
 * #5 (part 1) + #2 (integration) — checkAndProcessExpense end to end.
 *
 * The catalog port is a stub (the only external dependency); the database, rule
 * matching, allocation, hold creation, sign-off hold and state transitions are all
 * real. Covers the happy path, both negative hold paths, idempotency, hold
 * resolution, the sign-off hold, and the failure→qb_error path.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { seedExpense, seedLineItem, seedAccountMapping, signAllLines, bindPorts, ORG } from "../helpers/seed";

const inv = vi.hoisted(() => ({
  listCategories: vi.fn(),
  listSubcategories: vi.fn(),
  lookupItems: vi.fn(),
  getItem: vi.fn(),
}));

import { checkAndProcessExpense } from "../../lib/expense-qb-processor";

/** Default catalog: one category/subcategory, every part resolves cleanly. */
function catalogResolvesAll(gtinByItemId: Record<number, string>) {
  inv.listCategories.mockResolvedValue([{ id: 1, name: "Hardware", letter: "H" }]);
  inv.listSubcategories.mockResolvedValue([{ id: 10, name: "Cables", number: 1, categoryId: 1 }]);
  inv.lookupItems.mockResolvedValue(
    Object.entries(gtinByItemId).map(([id, gtin13]) => ({
      index: Number(id),
      gtin13,
      conversionVersion: 1,
    })),
  );
  inv.getItem.mockImplementation(async (gtin13: string) =>
    Object.values(gtinByItemId).includes(gtin13)
      ? { gtin13, categoryId: 1, subcategoryId: 10 }
      : null,
  );
}

async function stateOf(id: string): Promise<string> {
  const row = await db.expense.findFirst({ where: { id } });
  return row!.state;
}
const holdsFor = (id: string) =>
  db.expenseHold.findMany({ where: { expenseId: id } });
const eventsFor = (id: string) =>
  db.expenseEvent.findMany({ where: { expenseId: id } });

beforeEach(() => {
  vi.clearAllMocks();
  bindPorts({ catalog: inv });
});

describeDb("checkAndProcessExpense — happy path", () => {
  it("emits a QB event, completes, and allocates tax to the penny", async () => {
    const id = await seedExpense({ state: "qb_pending", taxCents: 10, receiptTotalCents: 110 });
    const li1 = await seedLineItem(id, { partNumber: "PN-1", totalPriceCents: 75 });
    const li2 = await seedLineItem(id, { partNumber: "PN-2", totalPriceCents: 25 });
    catalogResolvesAll({ [li1]: "0000000000017", [li2]: "0000000000024" });
    await seedAccountMapping({ qbAccount: "4000" }); // wildcard rule

    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_complete");

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload) as { items: Array<{ lineItemId: number; allocatedTaxCents: number; account: string }> };
    const tax = payload.items.reduce((s, i) => s + i.allocatedTaxCents, 0);
    expect(tax).toBe(10); // 10 cents conserved exactly
    expect(payload.items.every((i) => i.account === "4000")).toBe(true);

    const lis = await db.expenseLineItem.findMany({ where: { expenseId: id } });
    expect(lis.find((l) => l.id === li1)!.allocatedTaxCents).toBe(8);
    expect(lis.find((l) => l.id === li2)!.allocatedTaxCents).toBe(2);
  });
});

describeDb("checkAndProcessExpense — negative / hold paths", () => {
  it("creates a NO_MATCH hold and parks the expense on qb_on_hold when no rule matches", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    const li = await seedLineItem(id, { partNumber: "PN-1", totalPriceCents: 100 });
    catalogResolvesAll({ [li]: "0000000000017" });
    // No account mapping seeded → no rule matches.

    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_on_hold");
    const holds = await holdsFor(id);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ reason: "NO_MATCH", status: "PENDING", lineItemId: li });
    expect(await eventsFor(id)).toHaveLength(0);
  });

  it("creates a NO_PART_NUMBER hold for an unmapped manual line item", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: null, totalPriceCents: 50 });
    catalogResolvesAll({}); // nothing to look up

    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_on_hold");
    const holds = await holdsFor(id);
    expect(holds[0]).toMatchObject({ reason: "NO_PART_NUMBER", status: "PENDING", lineItemId: li });
  });

  it("resolves a manual line item via its manualQbAccount without a hold", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    await seedLineItem(id, { partNumber: null, manualQbAccount: "5000", totalPriceCents: 50 });
    catalogResolvesAll({});

    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_complete");
    expect(await holdsFor(id)).toHaveLength(0);
  });
});

describeDb("checkAndProcessExpense — idempotency & resolution", () => {
  it("is a no-op when a QB event already exists for the expense", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    await db.expenseEvent.create({ data: { orgId: ORG, expenseId: id, payload: "{}" } });

    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);

    expect(inv.lookupItems).not.toHaveBeenCalled();
    expect(await eventsFor(id)).toHaveLength(1); // unchanged
  });

  it("resolves pending holds and completes when re-run from qb_on_hold with a valid rule", async () => {
    const id = await seedExpense({ state: "qb_on_hold" });
    const li = await seedLineItem(id, { partNumber: "PN-1", totalPriceCents: 100 });
    await db.expenseHold.create({
      data: { orgId: ORG, expenseId: id, lineItemId: li, reason: "NO_MATCH", matchedRows: "[]", status: "PENDING" },
    });
    catalogResolvesAll({ [li]: "0000000000017" });
    await seedAccountMapping({ qbAccount: "4000" });

    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_complete");
    const holds = await holdsFor(id);
    expect(holds.every((h) => h.status === "RESOLVED")).toBe(true);
  });
});

describeDb("checkAndProcessExpense — failure path", () => {
  it("moves to qb_error and writes an audit row when processing throws", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    await seedLineItem(id, { partNumber: "PN-1", totalPriceCents: 100 });
    inv.listCategories.mockRejectedValue(new Error("catalog down"));
    inv.listSubcategories.mockResolvedValue([]);
    inv.lookupItems.mockResolvedValue([]);

    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_error");
    const audit = await db.expenseAuditLog.findMany({
      where: { expenseId: id, action: "qb_processing_failed" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ valueBefore: "qb_pending", valueAfter: "qb_error" });
  });

  it("ignores an expense that is not in a QB-processable state", async () => {
    const id = await seedExpense({ state: "owner_approval" });

    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("owner_approval");
    expect(inv.lookupItems).not.toHaveBeenCalled();
  });
});

describeDb("checkAndProcessExpense — sign-off hold", () => {
  it("emits nothing while a line has an unfilled seat", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    await seedLineItem(id, { partNumber: null, manualQbAccount: "5000", totalPriceCents: 50 });

    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_pending");
    expect(await eventsFor(id)).toHaveLength(0);
  });

  it("lands a backfilled expense on qb_skipped without seats", async () => {
    const id = await seedExpense({ state: "qb_pending", backfill: true });
    await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });

    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_skipped");
    expect(await eventsFor(id)).toHaveLength(0);
  });
});
