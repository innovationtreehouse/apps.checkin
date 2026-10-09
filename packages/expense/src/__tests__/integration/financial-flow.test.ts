/**
 * #4 (part 2) — Financial-flow auto-transitions against the real database.
 *
 * These functions decide when an expense advances stages based on approval and
 * threshold state. checkAndProcessExpense (the QB side-effect at qb_pending) is
 * stubbed here so the tests isolate the transition logic; the QB pipeline has
 * its own integration test.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import {
  seedExpense,
  seedLineItem,
  seedApproval,
  seedOrgSettings,
  seedPartOwner,
  bindPorts,
  directory,
  ORG,
} from "../helpers/seed";

const checkAndProcessExpense = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/expense-qb-processor", () => ({ checkAndProcessExpense }));

import {
  initFinancialFlow,
  checkOwnershipAutoTransition,
  checkApprovalAutoTransition,
} from "../../lib/financial-flow";

const ACTOR = { userId: 1, username: "finance" };

async function stateOf(id: string): Promise<string> {
  const row = await db.expense.findFirst({ where: { id } });
  return row!.state;
}

beforeEach(() => checkAndProcessExpense.mockClear());

describeDb("initFinancialFlow", () => {
  it("goes to owner_approval when every line item resolves an owner", async () => {
    const id = await seedExpense({ state: "pending" });
    await seedLineItem(id, { gtin13: "0000000000017" });
    await seedPartOwner({ gtin13: "0000000000017", ownerId: 99 });

    await initFinancialFlow(id, ORG);

    expect(await stateOf(id)).toBe("owner_approval");
  });

  it("goes to assign_ownership when an owner cannot be resolved", async () => {
    const id = await seedExpense({ state: "pending" });
    await seedLineItem(id, { gtin13: "0000000000024" }); // no part-owner row

    await initFinancialFlow(id, ORG);

    expect(await stateOf(id)).toBe("assign_ownership");
  });

  it("pre-approves a line whose bucket is org-level", async () => {
    bindPorts({ signoff: directory({ orgLevel: [7] }) });
    const id = await seedExpense({ state: "pending" });
    await seedLineItem(id, { gtin13: "0000000000017" });
    await seedPartOwner({ gtin13: "0000000000017", ownerId: 7 });

    await initFinancialFlow(id, ORG);

    const [approval] = await db.lineItemOwnerApproval.findMany({ where: { expenseId: id } });
    expect(approval).toMatchObject({ ownerId: 7, status: "approved", decidedByUserId: null });
  });

  it("backfill pre-approves every line without attributing it to the payload's submitter", async () => {
    const id = await seedExpense({ state: "pending", submitterId: 77 });
    await seedLineItem(id);

    await initFinancialFlow(id, ORG, true);

    const [approval] = await db.lineItemOwnerApproval.findMany({ where: { expenseId: id } });
    expect(approval).toMatchObject({ status: "approved", decidedByUserId: null });
    expect(await stateOf(id)).toBe("owner_approval");
  });
});

describeDb("checkOwnershipAutoTransition", () => {
  it("advances to owner_approval once all owners are assigned and none unknown", async () => {
    const id = await seedExpense({ state: "assign_ownership" });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 5, status: "pending" });

    await checkOwnershipAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("owner_approval");
  });

  it("stays in assign_ownership while an owner is still missing", async () => {
    const id = await seedExpense({ state: "assign_ownership" });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: null, status: "pending" });

    await checkOwnershipAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("assign_ownership");
  });
});

describeDb("checkApprovalAutoTransition", () => {
  beforeEach(() => seedOrgSettings({ capitalTotalThresholdCents: 5000, capitalLineItemThresholdCents: 2500 }));

  it("does nothing until every approval is terminal", async () => {
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 100 });
    const li = await seedLineItem(id, { unitPriceCents: 100 });
    await seedApproval(id, li, { ownerId: 5, status: "pending" });

    await checkApprovalAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("owner_approval");
    expect(checkAndProcessExpense).not.toHaveBeenCalled();
  });

  it("routes a non-capital expense to qb_pending and kicks off QB processing", async () => {
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 100 });
    const li = await seedLineItem(id, { unitPriceCents: 100 });
    await seedApproval(id, li, { ownerId: 5, status: "approved" });

    await checkApprovalAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("qb_pending");
    expect(checkAndProcessExpense).toHaveBeenCalledOnce();
  });

  it("routes to capital_review when the receipt total exceeds the threshold", async () => {
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 6000 });
    const li = await seedLineItem(id, { unitPriceCents: 100 });
    await seedApproval(id, li, { ownerId: 5, status: "approved" });

    await checkApprovalAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("capital_review");
    expect(checkAndProcessExpense).not.toHaveBeenCalled();
  });

  it("routes to the rejected terminal state when an approval is rejected and does NOT kick off QB", async () => {
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 100 });
    const li = await seedLineItem(id, { unitPriceCents: 100 });
    await seedApproval(id, li, { ownerId: 5, status: "rejected" });

    await checkApprovalAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("rejected");
    expect(checkAndProcessExpense).not.toHaveBeenCalled();
  });

  it("one rejected line refuses the whole expense even when other lines are approved", async () => {
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 200 });
    const li1 = await seedLineItem(id, { unitPriceCents: 100 });
    const li2 = await seedLineItem(id, { unitPriceCents: 100 });
    await seedApproval(id, li1, { ownerId: 5, status: "approved" });
    await seedApproval(id, li2, { ownerId: 5, status: "rejected" });

    await checkApprovalAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("rejected");
    expect(checkAndProcessExpense).not.toHaveBeenCalled();
  });

  it("a rejected line refuses even a capital expense (no capital_review)", async () => {
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 6000 });
    const li = await seedLineItem(id, { unitPriceCents: 100 });
    await seedApproval(id, li, { ownerId: 5, status: "rejected" });

    await checkApprovalAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("rejected");
    expect(checkAndProcessExpense).not.toHaveBeenCalled();
  });

  it("routes to capital_review when a single line item exceeds the line threshold", async () => {
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 100 });
    const li = await seedLineItem(id, { unitPriceCents: 3000 });
    await seedApproval(id, li, { ownerId: 5, status: "finance_assigned" });

    await checkApprovalAutoTransition(id, ACTOR);

    expect(await stateOf(id)).toBe("capital_review");
  });
});
