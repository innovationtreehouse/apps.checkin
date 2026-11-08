/** The Problems list's read port: failed payloads and catalog events, and expenses whose last QuickBooks post failed. */
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { bindPorts, ORG, seedExpense } from "../helpers/seed";

beforeEach(() => bindPorts({}));

describeDb("stuckItems", () => {
  it("lists each stuck item with its page; an expense is timed by its latest QuickBooks failure", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    const later = new Date("2026-11-03T10:00:00Z");
    await db.receivedExpensePayload.create({ data: { orgId: ORG, receiptId: "r1", payloadJson: "{}", status: "failed", failureReason: "bad", receivedAt: at } });
    await db.receivedExpensePayload.create({ data: { orgId: ORG, receiptId: "r2", payloadJson: "{}", status: "created" } });
    await db.receivedExpensePayload.create({ data: { orgId: "org-2", receiptId: "r3", payloadJson: "{}", status: "failed" } });
    await db.expenseReceivedOrgEvent.create({ data: { id: 51, orgId: ORG, eventType: "item_reviewed", payload: "{}", receivedAt: at, status: "failed", failureReason: "boom" } });

    const audited = await seedExpense({ submittedAt: at });
    await db.expense.update({ where: { id: audited }, data: { qbMatchState: "POST_FAILED", qbFailureKind: "system" } });
    for (const changedAt of [at, later]) {
      await db.expenseAuditLog.create({ data: { expenseId: audited, userId: 0, action: "qb_post_failed", changedAt } });
    }
    const unaudited = await seedExpense({ submittedAt: at });
    await db.expense.update({ where: { id: unaudited }, data: { qbMatchState: "NEEDS_FINANCE", qbFailureKind: "data" } });
    await seedExpense();

    const items = await stuckItems();

    expect(items).toHaveLength(4);
    expect(items).toEqual(expect.arrayContaining([
      { id: "r1", step: "intake", href: "/receipts/r1", failedAt: at },
      { id: "51", step: "catalog event", href: null, failedAt: at },
      { id: audited, step: "QuickBooks posting", href: `/expense/expenses/${audited}`, failedAt: later },
      { id: unaudited, step: "QuickBooks posting", href: `/expense/expenses/${unaudited}`, failedAt: at },
    ]));
  });
});
