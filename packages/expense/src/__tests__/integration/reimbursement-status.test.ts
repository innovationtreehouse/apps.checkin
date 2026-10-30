/** X12: a receipt's "paid on" read from QuickBooks against the real database. */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, seedExpense } from "../helpers/seed";
import { inertQbReader, QuickBooksNotConnectedError, type QbBillBalance } from "../../contract";
import { reimbursementStatus } from "../../services/reimbursementStatus";

const PAYMENTS: Record<string, string> = { p1: "2026-06-01", p2: "2026-06-20" };

function bindQb(bills: QbBillBalance[], purchases: { id: string; txnDate: string }[] = []) {
  bindPorts({
    quickbooks: {
      reader: {
        ...inertQbReader,
        billsByIds: async (ids) => bills.filter((b) => ids.includes(b.id)),
        billPaymentsByIds: async (ids) => ids.filter((id) => PAYMENTS[id]).map((id) => ({ id, txnDate: PAYMENTS[id] })),
        purchasesByIds: async (ids) =>
          purchases.filter((p) => ids.includes(p.id)).map((p) => ({ ...p, totalCents: 0, accountRef: null, vendorRef: null })),
      },
    },
  });
}

async function bookedBill(billId: string): Promise<string> {
  const id = await seedExpense({ needsReimbursement: true, reimburseePersonId: 1 });
  await db.expense.update({ where: { id }, data: { qbMatchState: "CREATED", qbTxnEntity: "Bill", qbTxnId: billId } });
  return id;
}

const ask = (receiptId: string, qb: { qbEntity?: string | null; qbTxnId?: string | null } = {}) => ({ receiptId, ...qb });

describeDb("X12 reimbursement status", () => {
  it("a settled Bill is paid on its latest BillPayment", async () => {
    bindQb([{ id: "b1", txnDate: "2026-05-01", balance: 0, paymentIds: ["p1", "p2"] }]);
    const id = await bookedBill("b1");
    expect(await reimbursementStatus.forReceipts([ask(id)])).toEqual(new Map([[id, { paidOn: "2026-06-20" }]]));
  });

  it("an open, partly paid or unreported balance is not yet paid", async () => {
    bindQb([
      { id: "b1", txnDate: "2026-05-01", balance: 100, paymentIds: [] },
      { id: "b2", txnDate: "2026-05-01", balance: 40, paymentIds: ["p1"] },
      { id: "b3", txnDate: "2026-05-01", balance: 0, paymentIds: [] },
      { id: "b4", txnDate: "2026-05-01", balance: null, paymentIds: ["p1"] },
    ]);
    const ids = [await bookedBill("b1"), await bookedBill("b2"), await bookedBill("b3"), await bookedBill("b4")];
    const paid = await reimbursementStatus.forReceipts(ids.map((id) => ask(id)));
    expect([...paid.values()]).toEqual(ids.map(() => ({ paidOn: null })));
  });

  it("a receipt with no booked Bill, or a Bill QuickBooks does not return, is not yet paid", async () => {
    bindQb([]);
    const unbooked = await seedExpense({ needsReimbursement: true, reimburseePersonId: 1 });
    const missing = await bookedBill("gone");
    const paid = await reimbursementStatus.forReceipts([ask(unbooked), ask(missing), ask("no-such-expense")]);
    expect([...paid.values()]).toEqual([{ paidOn: null }, { paidOn: null }, { paidOn: null }]);
  });

  it("a backfilled Purchase is paid on its own date", async () => {
    bindQb([], [{ id: "h1", txnDate: "2025-02-03" }]);
    const paid = await reimbursementStatus.forReceipts([
      ask("r1", { qbEntity: "Purchase", qbTxnId: "h1" }),
      ask("r2", { qbEntity: "Purchase", qbTxnId: "h2" }),
      ask("r3", { qbEntity: null, qbTxnId: "h1" }),
    ]);
    expect(paid).toEqual(
      new Map([
        ["r1", { paidOn: "2025-02-03" }],
        ["r2", { paidOn: null }],
        ["r3", { paidOn: null }],
      ]),
    );
  });

  it("a backfilled Bill is paid on its latest BillPayment, and not while open", async () => {
    bindQb(
      [
        { id: "h1", txnDate: "2025-03-04", balance: 0, paymentIds: ["p1", "p2"] },
        { id: "h2", txnDate: "2025-03-04", balance: 50, paymentIds: [] },
        { id: "h3", txnDate: "2025-03-04", balance: 0, paymentIds: [] },
      ],
      [{ id: "h2", txnDate: "2025-02-03" }],
    );
    const paid = await reimbursementStatus.forReceipts([
      ask("r1", { qbEntity: "Bill", qbTxnId: "h1" }),
      ask("r2", { qbEntity: "Bill", qbTxnId: "h2" }),
      ask("r3", { qbEntity: "Bill", qbTxnId: "h3" }),
    ]);
    expect(paid).toEqual(
      new Map([
        ["r1", { paidOn: "2026-06-20" }],
        ["r2", { paidOn: null }],
        ["r3", { paidOn: null }],
      ]),
    );
  });

  it("throws, never answers 'not yet paid', while QuickBooks is off", async () => {
    bindPorts({});
    const id = await bookedBill("b1");
    await expect(reimbursementStatus.forReceipts([ask(id)])).rejects.toBeInstanceOf(QuickBooksNotConnectedError);
  });

  it("reads nothing for a receipt with no QuickBooks entry, so it is not yet paid while QuickBooks is off", async () => {
    bindPorts({});
    const unbooked = await seedExpense({ needsReimbursement: true, reimburseePersonId: 1 });
    expect(await reimbursementStatus.forReceipts([ask(unbooked)])).toEqual(new Map([[unbooked, { paidOn: null }]]));
  });

  it("reads only this org's expenses", async () => {
    bindQb([{ id: "b1", txnDate: "2026-05-01", balance: 0, paymentIds: ["p1"] }]);
    const id = await seedExpense({ orgId: "other-org", needsReimbursement: true });
    await db.expense.update({ where: { id }, data: { qbTxnEntity: "Bill", qbTxnId: "b1" } });
    expect(await reimbursementStatus.forReceipts([ask(id)])).toEqual(new Map([[id, { paidOn: null }]]));
  });
});
