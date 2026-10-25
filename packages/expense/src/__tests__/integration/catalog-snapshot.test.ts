/**
 * A line's catalog inputs to its QuickBooks account are fixed at sign-off: a later catalog edit
 * does not move a signed line's account, a void clears the snapshot, and a line whose snapshot
 * failed at sign-off takes it at its first successful posting lookup.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedAccountMapping, seedApproval, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { signLine } from "../../services/signoffService";
import { financeAssign, raiseException } from "../../services/approvalService";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";

const GTIN = "0000000000017";
const FINANCE = principal(3, { isFinance: true });

const inv = vi.hoisted(() => ({
  listCategories: vi.fn(),
  listSubcategories: vi.fn(),
  lookupItems: vi.fn(),
  getItem: vi.fn(),
  getItemNames: vi.fn(),
}));

/** The item sits in Hardware/Cables (account 4000) or Tools/Drills (account 5000). */
function catalogFiles(lineItemId: number, under: "Hardware" | "Tools") {
  inv.listCategories.mockResolvedValue([{ id: 1, name: "Hardware", letter: "H" }, { id: 2, name: "Tools", letter: "T" }]);
  inv.listSubcategories.mockResolvedValue([
    { id: 10, name: "Cables", number: 1, categoryId: 1 },
    { id: 20, name: "Drills", number: 1, categoryId: 2 },
  ]);
  inv.lookupItems.mockResolvedValue([{ index: lineItemId, gtin13: GTIN, conversionVersion: 1 }]);
  inv.getItem.mockResolvedValue(
    under === "Hardware" ? { gtin13: GTIN, categoryId: 1, subcategoryId: 10 } : { gtin13: GTIN, categoryId: 2, subcategoryId: 20 },
  );
}

async function seedLine(): Promise<{ id: string; li: number }> {
  const id = await seedExpense({ state: "owner_approval" });
  const li = await seedLineItem(id, { partNumber: "PN-1" });
  await seedApproval(id, li, { ownerId: 100 });
  await seedAccountMapping({ category: "Hardware", qbAccount: "4000" });
  await seedAccountMapping({ category: "Tools", qbAccount: "5000" });
  return { id, li };
}

async function postedAccount(id: string): Promise<string> {
  await db.expense.update({ where: { id }, data: { state: "qb_pending" } });
  await checkAndProcessExpense(ORG, id);
  return (await db.expenseLineItem.findFirstOrThrow({ where: { expenseId: id } })).resolvedQbAccount!;
}

const snapshot = async (li: number) =>
  db.expenseLineItem.findUniqueOrThrow({ where: { id: li }, select: { signedGtin13: true, signedCategory: true, signedSubcategory: true } });

beforeEach(() => {
  vi.clearAllMocks();
  bindPorts({ catalog: inv, signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [3], board: [5] }) });
});

describeDb("a signed line's account is fixed at sign-off", () => {
  it("a catalog edit after sign-off does not move the line's account", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");
    await signLine(FINANCE, li, "TREASURER");
    expect(await snapshot(li)).toEqual({ signedGtin13: GTIN, signedCategory: "Hardware", signedSubcategory: "Cables" });

    catalogFiles(li, "Tools");
    expect(await postedAccount(id)).toBe("4000");
  });

  it("before sign-off completes, the live catalog is used", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");
    expect((await snapshot(li)).signedCategory).toBeNull();

    catalogFiles(li, "Tools");
    await signLine(FINANCE, li, "TREASURER");
    expect(await postedAccount(id)).toBe("5000");
  });

  it("a catalog failure at sign-off leaves the snapshot to the first successful posting lookup", async () => {
    const { id, li } = await seedLine();
    inv.lookupItems.mockRejectedValue(new Error("catalog down"));
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");
    await signLine(FINANCE, li, "TREASURER");
    expect((await snapshot(li)).signedCategory).toBeNull();

    catalogFiles(li, "Hardware");
    expect(await postedAccount(id)).toBe("4000");
    expect((await snapshot(li)).signedCategory).toBe("Hardware");
  });

  it("voiding the line's sign-offs clears its snapshot", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");
    await signLine(FINANCE, li, "TREASURER");

    const approval = await db.lineItemOwnerApproval.findFirstOrThrow({ where: { lineItemId: li } });
    await raiseException(principal(2), id, approval.id, "not ours");
    await financeAssign(FINANCE, id, approval.id, 101);
    expect(await snapshot(li)).toEqual({ signedGtin13: null, signedCategory: null, signedSubcategory: null });
  });
});
