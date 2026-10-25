/** The finance queue's expense tabs: each reason is read from the record, and counts are this viewer's. */
import { beforeEach, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { financeQueueActionable, financeQueueCounts, financeQueueRows } from "../../services/financeQueueService";
import { raiseFlag } from "../../services/flagService";

const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

const codes = async (p: typeof FINANCE, tab: Parameters<typeof financeQueueRows>[1], id: string) =>
  (await financeQueueRows(p, tab)).find((r) => r.expenseId === id)?.reasons.map((x) => x.code) ?? [];

beforeEach(() => {
  bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5, 6], households: [[1, 11]] }) });
});

describeDb("finance queue — expenses tab", () => {
  it("lists the finance steps from the expense's own state, and one row per expense with its reasons", async () => {
    const id = await seedExpense({ state: "capital_review", taxCents: 120, needsReimbursement: true });
    expect(await codes(FINANCE, "expenses", id)).toEqual(["CAPITAL_REVIEW", "REIMBURSEE_TO_NAME", "TAX_NOT_REVIEWED"]);
    const [row] = await financeQueueRows(FINANCE, "expenses");
    expect(row).toMatchObject({ expenseId: id, vendorName: "Acme", amountCents: 100, currency: "USD" });
    expect(row.reasons.find((x) => x.code === "TAX_NOT_REVIEWED")?.text).toBe("Tax $1.20 not reviewed on the receipt");
  });

  it("drops tax the receipt's finance approval covered", async () => {
    const id = await seedExpense({ state: "qb_pending", taxCents: 120 });
    await db.expenseReceiptReview.create({ data: { expenseId: id, taxReviewRequired: true, reasons: ["tax"], approvedTaxCents: 120 } });
    expect(await codes(FINANCE, "expenses", id)).toEqual([]);
  });

  it("lists a failed intake with the payload's vendor and amount, linking to Receiving", async () => {
    await db.receivedExpensePayload.create({
      data: { orgId: ORG, receiptId: "r-failed", status: "failed", failureReason: "boom", payloadJson: JSON.stringify({ vendorName: "Bolt", receiptTotalCents: 900, receiptDate: "2026-10-02", currency: "USD" }) },
    });
    const [row] = await financeQueueRows(FINANCE, "expenses");
    expect(row).toMatchObject({ expenseId: null, vendorName: "Bolt", amountCents: 900, date: "2026-10-02" });
    expect(row.reasons).toEqual([{ code: "INTAKE_FAILED", text: "Receipt didn't become an expense", href: "/inventory/receiving?queue=failed" }]);
  });

  it("counts a decision for FINANCE not conflicted on the expense, bookkeeping for any FINANCE, and nothing for the Board", async () => {
    await seedExpense({ state: "capital_review", submitterId: 11, needsReimbursement: true });
    expect((await financeQueueCounts(FINANCE)).expenses).toEqual({ actionable: 2, total: 2, byReason: { CAPITAL_REVIEW: 1, REIMBURSEE_TO_NAME: 1 } });
    expect((await financeQueueCounts(BOARD)).expenses).toEqual({ actionable: 0, total: 2, byReason: {} });

    bindPorts({ signoff: directory({ finance: [3], households: [[3, 11]] }) });
    expect((await financeQueueCounts(FINANCE)).expenses).toEqual({ actionable: 1, total: 2, byReason: { CAPITAL_REVIEW: 1 } });
  });

  it("gives a viewer with neither role nothing", async () => {
    await seedExpense({ state: "capital_review" });
    expect(await financeQueueActionable(principal(2))).toBe(0);
    expect(await financeQueueRows(principal(2), "expenses")).toEqual([]);
  });
});

describeDb("finance queue — QuickBooks tab", () => {
  it("reads exhausted posts and AMBIGUOUS from the match state, and the three reviews from their rows", async () => {
    const failed = await seedExpense({ state: "qb_complete" });
    await db.expense.update({ where: { id: failed }, data: { qbMatchState: "NEEDS_FINANCE", qbPostAttempts: 5 } });
    const ambiguous = await seedExpense({ state: "qb_complete" });
    await db.expense.update({ where: { id: ambiguous }, data: { qbMatchState: "AMBIGUOUS" } });
    const drift = await seedExpense({ state: "qb_complete" });
    await raiseFlag(drift, "QB_DRIFT", "amount, accounts", db, JSON.stringify({ amount: 200, accounts: ["60"] }));
    const dup = await seedExpense({ state: "qb_complete" });
    await raiseFlag(dup, "QB_DUPLICATE_TO_VOID", "needs voiding");

    const rows = await financeQueueRows(FINANCE, "quickbooks");
    const text = (id: string) => rows.find((r) => r.expenseId === id)?.reasons[0].text;
    expect(text(failed)).toBe("Posting failed 5 times");
    expect(text(ambiguous)).toBe("Several QuickBooks entries match; pick one");
    expect(text(drift)).toBe("Changed in QuickBooks after posting: amount, account");
    expect(text(dup)).toBe("Duplicate entry in QuickBooks needs voiding");
  });

  it("points an AMBIGUOUS reimbursement whose reimbursee has no vendor at the vendor link", async () => {
    const id = await seedExpense({ state: "qb_complete", needsReimbursement: true, reimburseePersonId: 7 });
    await db.expense.update({ where: { id }, data: { qbMatchState: "AMBIGUOUS" } });
    expect((await financeQueueRows(FINANCE, "quickbooks"))[0].reasons[0].text).toBe("The reimbursee has no QuickBooks vendor yet; link one");
  });

  it("lists an outboxed expense stopped for a bucket with no Class, and leaves a retired review out", async () => {
    const id = await seedExpense({ state: "qb_complete" });
    const line = await seedLineItem(id);
    await seedApproval(id, line, { ownerId: null, status: "approved" });
    await db.expenseEvent.create({ data: { orgId: ORG, expenseId: id } });
    await db.expenseFlag.create({ data: { orgId: ORG, expenseId: id, kind: "QB_NO_CLASS", audience: "FINANCE" } });

    const rows = await financeQueueRows(FINANCE, "quickbooks");
    expect(rows.map((r) => r.reasons.map((x) => [x.code, x.text]))).toEqual([[["QB_NO_CLASS", "A line has no budget bucket, so it has no QuickBooks class"]]]);
  });
});

describeDb("finance queue — account holds tab", () => {
  it("lists one row per held expense with its held line count", async () => {
    const id = await seedExpense({ state: "qb_pending" });
    const [a, b] = [await seedLineItem(id), await seedLineItem(id)];
    for (const lineItemId of [a, b]) await db.expenseHold.create({ data: { orgId: ORG, expenseId: id, lineItemId, reason: "NO_MATCH", matchedRows: "[]" } });
    expect((await financeQueueRows(FINANCE, "accountHolds")).map((r) => r.reasons[0].text)).toEqual(["2 lines have no account rule"]);
  });
});

describeDb("finance queue — To sign and Board tabs", () => {
  async function pending(opts: { receiptTotalCents?: number } = {}) {
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: opts.receiptTotalCents ?? 100 });
    const line = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, line, { ownerId: 100, status: "approved" });
    return { id, line };
  }

  it("counts the Treasurer lines a FINANCE holder may sign under To sign, and none for the Board", async () => {
    const { id } = await pending();
    expect(await codes(FINANCE, "toSign", id)).toEqual(["TREASURER_SIGNATURE"]);
    expect((await financeQueueCounts(FINANCE)).toSign).toMatchObject({ actionable: 1, total: 1 });
    expect((await financeQueueCounts(BOARD)).toSign).toMatchObject({ actionable: 0, total: 0 });
  });

  it("counts the Board's approval of a large purchase for FINANCE only, and shows it to the Board without a count", async () => {
    const { id } = await pending({ receiptTotalCents: 234_000 });
    const [row] = (await financeQueueRows(BOARD, "board")).filter((r) => r.expenseId === id);
    expect(row.reasons.map((x) => x.text)).toContain("Board approval of a $2,340.00 purchase not recorded");
    expect((await financeQueueCounts(FINANCE)).board.byReason).toMatchObject({ BOARD_APPROVAL: 1 });
    expect((await financeQueueCounts(BOARD)).board.byReason.BOARD_APPROVAL).toBeUndefined();

    await db.expense.update({ where: { id }, data: { boardAuthorization: "Board vote 10/1" } });
    expect(await codes(FINANCE, "board", id)).not.toContain("BOARD_APPROVAL");
  });

  it("counts a Board signature when no FINANCE holder without a conflict can take the Treasurer seat", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5, 6], households: [[1, 3]] }) });
    const { id } = await pending();
    expect(await codes(BOARD, "board", id)).toEqual(["BOARD_SIGNATURE"]);
    expect(await financeQueueActionable(BOARD)).toBe(1);
  });
});

describeDb("finance queue — a failure names its expense", () => {
  it("rejects with the step and the expense whose reasons could not be read, so the route's log points at it", async () => {
    const id = await seedExpense({ state: "capital_review" });
    bindPorts({ signoff: { ...directory({ finance: [3] }), householdOf: async () => Promise.reject(new Error("checkin is down")) } });
    await expect(financeQueueCounts(FINANCE)).rejects.toThrow(`finance queue: reading the queue reasons of expense ${id} failed: checkin is down`);
  });
});
