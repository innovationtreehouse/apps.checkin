/** The QuickBooks entry composed from gateway-stripped rows — no database. */
import { describe, it, expect } from "vitest";
import { composeWrite } from "../../qb-write";

const POSTING = { paymentType: "CreditCard" as const, paymentAccountId: "41" };

/** A two-line card charge as the gateway passes it. */
function bag(expense: Record<string, unknown> = {}) {
  return {
    Expense: { id: "e1", receiptDate: "2026-09-10", needsReimbursement: false, vendorName: "Acme", ...expense },
    ExpenseLineItem: [
      { id: 1, description: "Plywood", resolvedQbAccount: "60", totalPriceCents: 700, allocatedTaxCents: 50, allocatedShippingCents: 20, allocatedDiscountCents: 10 },
      { id: 2, description: "Screws", resolvedQbAccount: "61", totalPriceCents: 300, allocatedTaxCents: null, allocatedShippingCents: null, allocatedDiscountCents: null },
    ],
    LineItemOwnerApproval: [{ lineItemId: 1, ownerId: 7 }, { lineItemId: 2, ownerId: 100 }],
    BudgetOwner: [{ id: 7, name: "bucket-7", quickBooksClassId: "97" }, { id: 100, name: "bucket-100", quickBooksClassId: "9100" }],
    ExpenseReimburseeVendor: [{ qbVendorId: "77" }],
  };
}

describe("composeWrite", () => {
  it("a card charge is a Purchase from the payment account, a line per item with its account and Class", () => {
    expect(composeWrite(bag(), POSTING)).toEqual({
      write: {
        entity: "Purchase",
        fields: {
          txnDate: "2026-09-10",
          paymentType: "CreditCard",
          accountId: "41",
          lines: [
            { amountCents: 760, accountId: "60", classId: "97", description: "Plywood" },
            { amountCents: 300, accountId: "61", classId: "9100", description: "Screws" },
          ],
          memo: "Acme",
        },
      },
      lineAccounts: new Map([[1, "60"], [2, "61"]]),
    });
  });

  it("a reimbursement is a Bill to the reimbursee's Vendor", () => {
    expect(composeWrite(bag({ needsReimbursement: true }), POSTING)).toMatchObject({
      write: { entity: "Bill", fields: { txnDate: "2026-09-10", vendorId: "77", memo: "Acme" } },
    });
  });

  it("a reimbursement whose flag did not pass is not posted as a card charge", () => {
    const { needsReimbursement: _flag, ...expense } = bag().Expense;
    expect(composeWrite({ ...bag(), Expense: expense }, POSTING)).toEqual({ error: expect.stringMatching(/reimbursement flag/) });
  });

  it("a line whose price did not pass fails the post", () => {
    const [first, second] = bag().ExpenseLineItem;
    const { totalPriceCents: _price, ...stripped } = first;
    expect(composeWrite({ ...bag(), ExpenseLineItem: [stripped, second] }, POSTING)).toEqual({ error: expect.stringMatching(/did not pass/) });
  });

  it("a field the write does not read never reaches it", () => {
    const built = composeWrite(bag({ reimbursementFor: "Pat Example" }), POSTING);
    expect(JSON.stringify("write" in built ? built.write : built)).not.toContain("Pat Example");
  });
});
