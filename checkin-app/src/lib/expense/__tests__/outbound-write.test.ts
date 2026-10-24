/** The expense lane's QuickBooks write, composed inside the real quickbooks.create gateway. */
import { composeWrite } from "@checkin/expense/qb-write";
import { outboundCall } from "@/security/outbound";

const POSTING = { paymentType: "CreditCard" as const, paymentAccountId: "41" };
const REIMBURSEE = "Pat Example";

/** The rows the poster reads for a reimbursement, pii included, as Prisma returns them. */
function rows() {
  return {
    Expense: {
      id: "e1",
      orgId: "org-1",
      receiptDate: "2026-09-10",
      needsReimbursement: true,
      vendorName: "Acme Lumber",
      reimbursementFor: REIMBURSEE,
      reimburseePersonId: 4242,
      isTestData: false,
    },
    ExpenseLineItem: [
      { id: 1, expenseId: "e1", description: "Plywood", resolvedQbAccount: "60", totalPriceCents: 700, allocatedTaxCents: 50, allocatedShippingCents: 20, allocatedDiscountCents: 10 },
      { id: 2, expenseId: "e1", description: "Screws", resolvedQbAccount: "61", totalPriceCents: 300, allocatedTaxCents: null, allocatedShippingCents: null, allocatedDiscountCents: null },
    ],
    LineItemOwnerApproval: [{ lineItemId: 1, ownerId: 7 }, { lineItemId: 2, ownerId: 100 }],
    BudgetOwner: [
      { id: 7, name: "Robotics", archivedAt: null, quickBooksClassId: "97" },
      { id: 100, name: "Woodshop", archivedAt: null, quickBooksClassId: "9100" },
    ],
    ExpenseReimburseeVendor: [{ id: 3, orgId: "org-1", reimburseePersonId: 4242, qbVendorId: "77" }],
  };
}

function viaGateway() {
  return outboundCall("quickbooks.create", rows(), async (stripped) => ({ stripped, built: composeWrite(stripped, POSTING) }));
}

describe("expense QuickBooks write through quickbooks.create", () => {
  it("pins the Bill a known reimbursement posts", async () => {
    const { built } = await viaGateway();
    expect(built).toEqual({
      write: {
        entity: "Bill",
        fields: {
          txnDate: "2026-09-10",
          vendorId: "77",
          lines: [
            { amountCents: 760, accountId: "60", classId: "97", description: "Plywood" },
            { amountCents: 300, accountId: "61", classId: "9100", description: "Screws" },
          ],
          memo: "Acme Lumber",
        },
      },
      lineAccounts: new Map([[1, "60"], [2, "61"]]),
    });
  });

  it("pii fields never reach the write", async () => {
    const { stripped, built } = await viaGateway();
    expect(stripped.Expense).not.toHaveProperty("reimbursementFor");
    expect(stripped.Expense).not.toHaveProperty("reimburseePersonId");
    expect(stripped.ExpenseReimburseeVendor).toEqual([{ id: 3, orgId: "org-1", qbVendorId: "77" }]);
    expect(JSON.stringify(built)).not.toContain(REIMBURSEE);
    expect(JSON.stringify(built)).not.toContain("4242");
  });
});
