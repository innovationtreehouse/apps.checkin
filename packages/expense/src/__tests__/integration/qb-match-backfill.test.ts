/**
 * The expense-level match backfill (20261015120000_qb_match_expense_level) against the real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { seedExpense, seedLineItem } from "../helpers/seed";

const SQL = readFileSync(join(__dirname, "../../../prisma/migrations/20261015120000_qb_match_expense_level/migration.sql"), "utf8");

async function backfill() {
  for (const statement of SQL.replace(/^\s*--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.$executeRawUnsafe(statement);
  }
}

async function expenseWithMatchedLines(matched: string[], opts: { reimbursement?: boolean } = {}) {
  const id = await seedExpense({ needsReimbursement: opts.reimbursement ?? false, reimburseePersonId: opts.reimbursement ? 1 : undefined });
  await seedLineItem(id);
  for (const qbTxnId of matched) {
    const li = await seedLineItem(id);
    await db.expenseLineItem.update({ where: { id: li }, data: { qbMatchState: "MATCHED", qbTxnId } });
  }
  return id;
}

const state = (id: string) =>
  db.expense.findUnique({ where: { id }, select: { qbMatchState: true, qbTxnId: true, qbTxnEntity: true } });

describeDb("expense-level match backfill", () => {
  it("lifts one hand-matched line to its expense, and leaves the line as it was", async () => {
    const purchase = await expenseWithMatchedLines(["qb-1"]);
    const bill = await expenseWithMatchedLines(["qb-2"], { reimbursement: true });
    await backfill();
    expect(await state(purchase)).toEqual({ qbMatchState: "MATCHED", qbTxnId: "qb-1", qbTxnEntity: "Purchase" });
    expect(await state(bill)).toEqual({ qbMatchState: "MATCHED", qbTxnId: "qb-2", qbTxnEntity: "Bill" });
    expect(await db.expenseLineItem.count({ where: { expenseId: purchase, qbMatchState: "MATCHED", qbTxnId: "qb-1" } })).toBe(1);
  });

  it("parks an expense with more than one hand-matched line as AMBIGUOUS", async () => {
    const id = await expenseWithMatchedLines(["qb-1", "qb-2"]);
    await backfill();
    expect(await state(id)).toEqual({ qbMatchState: "AMBIGUOUS", qbTxnId: null, qbTxnEntity: null });
  });

  it("leaves an expense already in QuickBooks, or with no matched line, alone", async () => {
    const created = await expenseWithMatchedLines(["qb-1"]);
    await db.expense.update({ where: { id: created }, data: { qbMatchState: "CREATED", qbTxnId: "qb-9", qbTxnEntity: "Purchase" } });
    const plain = await expenseWithMatchedLines([]);
    await backfill();
    expect(await state(created)).toEqual({ qbMatchState: "CREATED", qbTxnId: "qb-9", qbTxnEntity: "Purchase" });
    expect(await state(plain)).toEqual({ qbMatchState: "UNMATCHED", qbTxnId: null, qbTxnEntity: null });
  });
});
