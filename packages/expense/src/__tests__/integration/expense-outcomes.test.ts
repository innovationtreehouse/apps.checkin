/**
 * The receipt port's expense outcomes against the real database: each receipt's expense is read
 * with its approvals and its lines the person reimbursed has not yet confirmed.
 */
import { beforeEach, it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, seedApproval, seedExpense, seedLineItem, seedSubmitterSeat } from "../helpers/seed";
import { expenseOutcomes } from "../../services/expenseOutcomes";

describeDb("expense outcomes for the receipt port", () => {
  beforeEach(() => {
    bindPorts({});
  });

  it("counts only lines missing the submitter seat as unconfirmed", async () => {
    const confirmed = await seedExpense({ state: "pending", needsReimbursement: true, reimburseePersonId: 8 });
    const line = await seedLineItem(confirmed);
    await seedApproval(confirmed, line, { ownerId: 100 });
    await seedSubmitterSeat(line, 8);
    await db.expenseLineSignoff.create({ data: { expenseId: confirmed, lineItemId: line, seat: "TREASURER", signerUserId: 3 } });

    const waiting = await seedExpense({ state: "pending", needsReimbursement: true, reimburseePersonId: 8 });
    const signedByTreasurer = await seedLineItem(waiting);
    await db.expenseLineSignoff.create({ data: { expenseId: waiting, lineItemId: signedByTreasurer, seat: "TREASURER", signerUserId: 3 } });
    await seedSubmitterSeat(await seedLineItem(waiting), 8);

    const outcomes = await expenseOutcomes.forReceipts([confirmed, waiting]);
    expect(outcomes.get(confirmed)).toEqual({ status: "awaiting_approval", notes: [] });
    expect(outcomes.get(waiting)).toEqual({ status: "awaiting_confirmation", notes: [] });
  });

  it("carries the notes of rejected lines, in approval order", async () => {
    const id = await seedExpense({ state: "rejected" });
    const first = await seedApproval(id, await seedLineItem(id), { status: "rejected" });
    const second = await seedApproval(id, await seedLineItem(id), { status: "approved" });
    const third = await seedApproval(id, await seedLineItem(id), { status: "rejected" });
    await db.lineItemOwnerApproval.update({ where: { id: first }, data: { notes: " Not a program cost " } });
    await db.lineItemOwnerApproval.update({ where: { id: second }, data: { notes: "Fine" } });
    await db.lineItemOwnerApproval.update({ where: { id: third }, data: { notes: "Duplicate" } });

    expect((await expenseOutcomes.forReceipts([id])).get(id)).toEqual({ status: "line_rejected", notes: ["Not a program cost", "Duplicate"] });
  });

  it("answers only for the asked receipts in the bound org", async () => {
    const mine = await seedExpense({ state: "qb_complete" });
    await seedExpense({ state: "qb_complete" });
    const elsewhere = await seedExpense({ state: "qb_complete", orgId: "org-2" });

    const outcomes = await expenseOutcomes.forReceipts([mine, elsewhere, "no-such-receipt"]);
    expect([...outcomes.keys()]).toEqual([mine]);
    expect(await expenseOutcomes.forReceipts([])).toEqual(new Map());
  });
});
