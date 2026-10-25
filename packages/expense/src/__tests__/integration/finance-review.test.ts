/** Decisions on the expense record (#2481): reasons, the closing acts, required notes and Approve tax. */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";
import { checkOffFlag, raiseFlag } from "../../services/flagService";
import { approveTax } from "../../services/taxApprovalService";
import { expenseReasons } from "../../services/reasonService";
import { writeAudit } from "../../lib/audit";

// submitter 1 · finance 3 and 4 · board 5 · 8 in the submitter's household, and a finance holder
const FINANCE = principal(3, { isFinance: true });
const CONFLICTED_FINANCE = principal(8, { isFinance: true });
const BOARD = principal(5, { isBoard: true });
const bind = () => bindPorts({ signoff: directory({ orgLevel: [100], finance: [3, 4, 8], board: [5], households: [[1, 8]] }) });

const openFlag = (expenseId: string, kind: string) => db.expenseFlag.findFirst({ where: { expenseId, kind } });

describeDb("reviews need a note", () => {
  it("refuses a blank note on each review kind and closes it with one", async () => {
    bind();
    const id = await seedExpense({ state: "qb_complete" });
    await raiseFlag(id, "QB_DRIFT", "amount");
    await raiseFlag(id, "QB_POST_HELD", "closed but not posted: a line is missing a sign-off seat");
    await raiseFlag(id, "QB_DUPLICATE_TO_VOID", "QuickBooks Purchase 9 is already claimed by another expense or line; the entry posted for this expense needs voiding");

    for (const kind of ["QB_DRIFT", "QB_POST_HELD", "QB_DUPLICATE_TO_VOID"]) {
      const flag = (await openFlag(id, kind))!;
      await expect(checkOffFlag(FINANCE, flag.id, null)).rejects.toMatchObject({ status: 400 });
      await expect(checkOffFlag(FINANCE, flag.id, "   ")).rejects.toMatchObject({ status: 400 });
      await checkOffFlag(FINANCE, flag.id, "voided Purchase 9 on 2026-10-24");
      expect((await openFlag(id, kind))!.checkedOffAt).not.toBeNull();
    }
  });
});

describeDb("Approve tax", () => {
  it("approves tax no receipt approval covers, with an optional note, and the reason clears", async () => {
    bind();
    const id = await seedExpense({ state: "owner_approval", taxCents: 1240 });
    expect((await expenseReasons(FINANCE, id)).map((r) => [r.code, r.actionable])).toEqual([["TAX_NOT_REVIEWED", true]]);

    await expect(approveTax(BOARD, id, null)).rejects.toMatchObject({ status: 403 });
    await expect(approveTax(CONFLICTED_FINANCE, id, null)).rejects.toMatchObject({ status: 403 });
    await approveTax(FINANCE, id, null);

    expect(await db.expenseTaxApproval.findUnique({ where: { expenseId: id } })).toMatchObject({ taxCents: 1240, approvedByUserId: 3, note: null });
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "tax_approved", userId: 3 } })).toBe(1);
    expect(await reasonCodes(id)).toEqual([]);
    await expect(approveTax(FINANCE, id, "again")).rejects.toMatchObject({ status: 409 });
  });

  it("an approval covers its amount only", async () => {
    bind();
    const id = await seedExpense({ state: "owner_approval", taxCents: 1240 });
    await approveTax(FINANCE, id, "checked against the invoice");
    await db.expense.update({ where: { id }, data: { taxCents: 1300 } });
    expect(await reasonCodes(id)).toEqual(["TAX_NOT_REVIEWED"]);
    await approveTax(FINANCE, id, null);
    expect(await db.expenseTaxApproval.findUnique({ where: { expenseId: id } })).toMatchObject({ taxCents: 1300, note: null });
  });

  it("refuses tax that waits on no one, and a closed expense", async () => {
    bind();
    await expect(approveTax(FINANCE, await seedExpense({ taxCents: 0 }), null)).rejects.toMatchObject({ status: 409 });
    await expect(approveTax(FINANCE, await seedExpense({ state: "qb_complete", taxCents: 500 }), null)).rejects.toMatchObject({ status: 400 });
  });
});

describeDb("expense reasons", () => {
  it("a reason is actionable for finance only, and never for someone conflicted on the expense", async () => {
    bind();
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true });
    const actionable = async (p: ReturnType<typeof principal>) => (await expenseReasons(p, id)).map((r) => [r.code, r.actionable]);
    expect(await actionable(FINANCE)).toEqual([["REIMBURSEE_TO_NAME", true]]);
    expect(await actionable(CONFLICTED_FINANCE)).toEqual([["REIMBURSEE_TO_NAME", false]]);
    expect(await actionable(BOARD)).toEqual([["REIMBURSEE_TO_NAME", false]]);
  });

  it("bookkeeping is actionable for any finance holder, a conflicted one included", async () => {
    bind();
    const id = await seedExpense({ state: "capital_review" });
    const line = await seedLineItem(id);
    await db.expenseHold.create({ data: { orgId: "org-1", expenseId: id, lineItemId: line, reason: "NO_MATCH", matchedRows: "[]" } });
    const actionable = async (p: ReturnType<typeof principal>) => (await expenseReasons(p, id)).map((r) => [r.code, r.actionable]);
    expect(await actionable(CONFLICTED_FINANCE)).toEqual([["CAPITAL_REVIEW", true], ["ACCOUNT_HOLD", true]]);
    expect(await actionable(BOARD)).toEqual([["CAPITAL_REVIEW", false], ["ACCOUNT_HOLD", false]]);
  });

  it("bookkeeping stays actionable for a conflicted finance holder, as the rules allow", async () => {
    bind();
    const id = await seedExpense({ state: "capital_review", taxCents: 500 });
    await db.expense.update({ where: { id }, data: { qbMatchState: "NEEDS_FINANCE", qbPostAttempts: 5 } });
    expect((await expenseReasons(CONFLICTED_FINANCE, id)).map((r) => [r.code, r.actionable])).toEqual([
      ["CAPITAL_REVIEW", true],
      ["TAX_NOT_REVIEWED", false],
      ["QB_POST_FAILED", true],
    ]);
  });

  it("an exhausted post carries the last error in plain words", async () => {
    bind();
    const id = await seedExpense({ state: "qb_complete" });
    await db.expense.update({ where: { id }, data: { qbMatchState: "NEEDS_FINANCE", qbPostAttempts: 5 } });
    await writeAudit(db, { userId: 0 }, { expenseId: id, action: "qb_needs_finance", notes: "attempt 5 of 5: Account is inactive" });
    expect(await expenseReasons(FINANCE, id)).toEqual([
      { code: "QB_POST_FAILED", tab: "qb", actionable: true, amountCents: null, count: 5, detail: "Account is inactive" },
    ]);
  });

  it("a Board approval to record counts for an unconflicted finance holder, not for the Board", async () => {
    bind();
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 500_000 });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 100 });
    const board = (p: ReturnType<typeof principal>) => expenseReasons(p, id).then((rs) => rs.find((r) => r.code === "BOARD_APPROVAL")?.actionable);
    expect(await board(FINANCE)).toBe(true);
    expect(await board(BOARD)).toBe(false);
  });
});

async function reasonCodes(id: string): Promise<string[]> {
  return (await expenseReasons(FINANCE, id)).map((r) => r.code);
}

