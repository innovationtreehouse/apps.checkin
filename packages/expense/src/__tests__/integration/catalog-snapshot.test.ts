/**
 * A line's catalog inputs to its QuickBooks account are fixed at sign-off for the first post: a later
 * catalog edit does not move a signed line's account, clearing a step clears the snapshot, and a line
 * whose snapshot failed at sign-off takes it at its first successful posting lookup. A person's Retry or
 * Resubmit before the expense is in QuickBooks reads the live catalog and audits each account it moves.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedAccountMapping, seedApproval, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { signLine } from "../../services/signoffService";
import { clearFrom } from "../../lib/signoff-facts";
import { checkAndProcessExpense, retryQbPost } from "../../lib/expense-qb-processor";
import { postExpenseToQb } from "../../lib/expense-qb-poster";
import { resubmitHeldExpense } from "../../services/holdService";
import { QuickBooksClient } from "@checkin/quickbooks";

vi.mock("../../lib/expense-qb-poster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/expense-qb-poster")>()),
  postExpenseToQb: vi.fn(async () => "posted" as const),
}));

const GTIN = "0000000000017";
const FINANCE = principal(3, { isFinance: true });

const inv = vi.hoisted(() => ({
  listCategories: vi.fn(),
  listSubcategories: vi.fn(),
  lookupItems: vi.fn(),
  getItem: vi.fn(),
  getActiveItem: vi.fn(),
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

async function seedLine(mapped: Array<"Hardware" | "Tools"> = ["Hardware", "Tools"]): Promise<{ id: string; li: number }> {
  const id = await seedExpense({ state: "owner_approval" });
  const li = await seedLineItem(id, { partNumber: "PN-1" });
  // A card charge approved by its bucket owner, so the Treasurer seat is next.
  await seedApproval(id, li, { ownerId: 100, status: "approved" });
  if (mapped.includes("Hardware")) await seedAccountMapping({ category: "Hardware", qbAccount: "4000" });
  if (mapped.includes("Tools")) await seedAccountMapping({ category: "Tools", qbAccount: "5000" });
  return { id, li };
}

async function postedAccount(id: string): Promise<string> {
  await db.expense.update({ where: { id }, data: { state: "qb_pending" } });
  await checkAndProcessExpense(ORG, id);
  return (await db.expenseLineItem.findFirstOrThrow({ where: { expenseId: id } })).resolvedQbAccount!;
}

const snapshot = async (li: number) =>
  db.expenseLineItem.findUniqueOrThrow({ where: { id: li }, select: { signedGtin13: true, signedCategory: true, signedSubcategory: true } });

const posting = {
  client: new QuickBooksClient({ current: async () => "tok" }, { env: "sandbox", realmId: "123" }),
  paymentAccountId: "35",
  paymentType: "CreditCard" as const,
  prod: false,
  sweepIncomplete: async () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  bindPorts({
    catalog: inv,
    signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [3], board: [5] }),
    quickbooks: { posting: async () => posting },
  });
});

const reresolved = (id: string) => db.expenseAuditLog.findMany({ where: { expenseId: id, action: "qb_account_reresolved" } });

describeDb("a signed line's account is fixed at sign-off", () => {
  it("a catalog edit after sign-off does not move the line's account", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    await signLine(FINANCE, li, "TREASURER");
    expect(await snapshot(li)).toEqual({ signedGtin13: GTIN, signedCategory: "Hardware", signedSubcategory: "Cables" });

    catalogFiles(li, "Tools");
    expect(await postedAccount(id)).toBe("4000");
  });

  it("before sign-off completes, the live catalog is used", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    expect((await snapshot(li)).signedCategory).toBeNull();

    catalogFiles(li, "Tools");
    await signLine(FINANCE, li, "TREASURER");
    expect(await postedAccount(id)).toBe("5000");
  });

  it("a catalog failure at sign-off leaves the snapshot to the first successful posting lookup", async () => {
    const { id, li } = await seedLine();
    inv.lookupItems.mockRejectedValue(new Error("catalog down"));
    await signLine(FINANCE, li, "TREASURER");
    expect((await snapshot(li)).signedCategory).toBeNull();

    catalogFiles(li, "Hardware");
    expect(await postedAccount(id)).toBe("4000");
    expect((await snapshot(li)).signedCategory).toBe("Hardware");
  });

  it("clearing the line's approval clears its snapshot", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    await signLine(FINANCE, li, "TREASURER");

    await db.$transaction((tx) => clearFrom(tx, { userId: 3 }, id, [li], "APPROVAL", "test"));
    expect(await snapshot(li)).toEqual({ signedGtin13: null, signedCategory: null, signedSubcategory: null });
  });
});

describeDb("a Retry or Resubmit before QuickBooks reads the live catalog", () => {
  it("a catalog fix releases a NO_MATCH hold on Resubmit and audits the change", async () => {
    const { id, li } = await seedLine(["Hardware"]);
    catalogFiles(li, "Tools");
    await signLine(FINANCE, li, "TREASURER");
    await db.expense.update({ where: { id }, data: { state: "qb_pending" } });
    await checkAndProcessExpense(ORG, id);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_on_hold");

    catalogFiles(li, "Hardware");
    await resubmitHeldExpense(FINANCE, id);

    expect((await db.expenseLineItem.findUniqueOrThrow({ where: { id: li } })).resolvedQbAccount).toBe("4000");
    expect(await db.expenseHold.count({ where: { expenseId: id, status: "PENDING" } })).toBe(0);
    expect((await snapshot(li)).signedCategory).toBe("Hardware");
    expect(await reresolved(id)).toMatchObject([
      { userId: 3, lineItemId: li, valueBefore: "Tools/Drills → no account", valueAfter: "Hardware/Cables → 4000" },
    ]);
  });

  it("an account change on retry writes an audit row naming the line and the person", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    await signLine(FINANCE, li, "TREASURER");
    expect(await postedAccount(id)).toBe("4000");
    await db.expense.update({ where: { id }, data: { qbMatchState: "POST_FAILED" } });

    catalogFiles(li, "Tools");
    expect(await retryQbPost(ORG, id, { userId: 3 })).toBe("posted");

    expect((await db.expenseLineItem.findUniqueOrThrow({ where: { id: li } })).resolvedQbAccount).toBe("5000");
    expect(await snapshot(li)).toEqual({ signedGtin13: GTIN, signedCategory: "Tools", signedSubcategory: "Drills" });
    expect(await reresolved(id)).toMatchObject([
      { userId: 3, lineItemId: li, valueBefore: "Hardware/Cables → 4000", valueAfter: "Tools/Drills → 5000" },
    ]);
  });

  it("a retry whose catalog read is unchanged writes no audit row", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    await signLine(FINANCE, li, "TREASURER");
    await postedAccount(id);
    await db.expense.update({ where: { id }, data: { qbMatchState: "POST_FAILED" } });

    expect(await retryQbPost(ORG, id, { userId: 3 })).toBe("posted");
    expect(await reresolved(id)).toHaveLength(0);
  });

  it("a posted expense is never re-resolved", async () => {
    const { id, li } = await seedLine();
    catalogFiles(li, "Hardware");
    await signLine(FINANCE, li, "TREASURER");
    await postedAccount(id);
    vi.mocked(postExpenseToQb).mockClear();

    for (const qbMatchState of ["CREATED", "MATCHED"] as const) {
      await db.expense.update({ where: { id }, data: { qbMatchState } });
      catalogFiles(li, "Tools");
      expect(await retryQbPost(ORG, id, { userId: 3 })).toBe(false);
    }
    expect((await db.expenseLineItem.findUniqueOrThrow({ where: { id: li } })).resolvedQbAccount).toBe("4000");
    expect((await snapshot(li)).signedCategory).toBe("Hardware");
    expect(await reresolved(id)).toHaveLength(0);
    expect(postExpenseToQb).not.toHaveBeenCalled();
  });
});
