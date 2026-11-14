/** An expense whose tax waits on finance does not close until finance approves that tax. */
import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { checkAndProcessExpense, recoverStrandedQbExpenses } from "../../lib/expense-qb-processor";
import { approveTax } from "../../services/taxApprovalService";
import { expenseReasons } from "../../services/reasonService";

const FINANCE = principal(3, { isFinance: true });
const TAX = 500;

beforeEach(() => bindPorts({ signoff: directory({ finance: [3, 4], board: [5] }) }));

/** A signed expense in qb_pending whose receipt holds its tax for finance review. */
async function readyToClose() {
  const id = await seedExpense({ state: "qb_pending", taxCents: TAX, receiptTotalCents: 1500 });
  await db.expenseReceiptReview.create({ data: { expenseId: id, taxReviewRequired: true, reasons: [] } });
  await seedLineItem(id, { manualQbAccount: "4000", totalPriceCents: 1000 });
  await signAllLines(id);
  return id;
}

const stateOf = async (id: string) => (await db.expense.findUniqueOrThrow({ where: { id } })).state;
const outboxRows = (id: string) => db.expenseEvent.count({ where: { expenseId: id } });
const reasonCodes = async (id: string) => (await expenseReasons(FINANCE, id)).map((r) => r.code);

describeDb("an expense whose tax waits on finance", () => {
  it("does not close or enter the outbox, and the tax reason stays in finance's queue", async () => {
    const id = await readyToClose();

    await checkAndProcessExpense(ORG, id);
    await recoverStrandedQbExpenses();

    expect(await stateOf(id)).toBe("qb_pending");
    expect(await outboxRows(id)).toBe(0);
    expect(await reasonCodes(id)).toContain("TAX_NOT_REVIEWED");
  });

  it("closes once finance approves the tax", async () => {
    const id = await readyToClose();
    await checkAndProcessExpense(ORG, id);

    await approveTax(FINANCE, id, null);

    expect(await stateOf(id)).toBe("qb_complete");
    expect(await outboxRows(id)).toBe(1);
    expect(await reasonCodes(id)).not.toContain("TAX_NOT_REVIEWED");
  });

  it("waits again when the tax changes after finance approved it", async () => {
    const id = await readyToClose();
    await db.expenseTaxApproval.create({ data: { expenseId: id, taxCents: TAX, approvedByUserId: 3 } });
    await db.expense.update({ where: { id }, data: { taxCents: TAX + 100 } });

    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_pending");
    expect(await outboxRows(id)).toBe(0);
    expect(await reasonCodes(id)).toContain("TAX_NOT_REVIEWED");
  });

  it("a backfill whose tax waits on finance does not close either", async () => {
    const id = await readyToClose();
    await db.expense.update({ where: { id }, data: { backfill: true } });

    await checkAndProcessExpense(ORG, id);

    expect(await stateOf(id)).toBe("qb_pending");
  });
});
