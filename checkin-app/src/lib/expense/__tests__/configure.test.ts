import type { QbReader, SignoffDirectory } from "@inventory/expense";

const personRoleFindMany = jest.fn();
const budgetOwnerFindUnique = jest.fn();
const budgetOwnerFindMany = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    personRole: { findMany: personRoleFindMany },
    budgetOwner: { findUnique: budgetOwnerFindUnique, findMany: budgetOwnerFindMany },
  },
}));

// The library's root entry pulls in its generated Prisma client, which the jest env does not build.
const configureExpense = jest.fn<void, [{ signoff: SignoffDirectory; quickbooks: { reader: QbReader } }]>();
jest.mock("@inventory/expense", () => ({ configureExpense }));
jest.mock("@/lib/catalog/configure", () => ({ getOrg: jest.fn() }));
const getQuickBooks = jest.fn();
jest.mock("@/lib/quickbooks/client", () => ({ getQuickBooks }));

const NOT_DENIED = { NOT: { household: { orgMembership: { status: "DENIED" } } } };

async function signoff(): Promise<SignoffDirectory> {
  await jest.isolateModulesAsync(async () => {
    (await import("../configure")).configureRuntime();
  });
  return configureExpense.mock.calls.at(-1)![0].signoff;
}

beforeEach(() => jest.clearAllMocks());

describe("expense signer directory excludes people in a DENIED household", () => {
  it("FINANCE and BOARD holders", async () => {
    personRoleFindMany.mockResolvedValue([{ personId: 4 }]);
    const dir = await signoff();

    await expect(dir.financeHolders()).resolves.toEqual([4]);
    await dir.boardMembers();

    for (const [{ where }] of personRoleFindMany.mock.calls) {
      expect(where.person).toEqual({ mergedIntoId: null, ...NOT_DENIED });
    }
  });

  it("a bucket's lead mentor and treasurers", async () => {
    budgetOwnerFindUnique.mockResolvedValue({
      programId: 1,
      program: {
        leadMentor: { id: 7, mergedIntoId: null, household: { orgMembership: { status: "DENIED" } } },
        volunteers: [{ personId: 8 }],
      },
    });
    const dir = await signoff();

    await expect(dir.bucketApprovers(100)).resolves.toEqual({ orgLevel: false, approvers: [8] });
    expect(budgetOwnerFindUnique.mock.calls[0][0].select.program.select.volunteers.where.person).toEqual({ mergedIntoId: null, ...NOT_DENIED });
  });

  it("the buckets a person approves", async () => {
    budgetOwnerFindMany.mockResolvedValue([]);
    const dir = await signoff();

    await dir.bucketsApprovedBy(7);

    const [lead, treasurer] = budgetOwnerFindMany.mock.calls[0][0].where.program.OR;
    expect(lead.leadMentor).toEqual({ mergedIntoId: null, ...NOT_DENIED });
    expect(treasurer.volunteers.some.person).toEqual({ mergedIntoId: null, ...NOT_DENIED });
  });
});

describe("expense QuickBooks reader", () => {
  async function reader(): Promise<QbReader> {
    await jest.isolateModulesAsync(async () => {
      (await import("../configure")).configureRuntime();
    });
    return configureExpense.mock.calls.at(-1)![0].quickbooks.reader;
  }

  it("reads no rows while QuickBooks is off", async () => {
    getQuickBooks.mockResolvedValue(null);
    const qb = await reader();
    await expect(qb.purchasesBetween("2026-01-01", "2026-01-31")).resolves.toEqual([]);
    await expect(qb.billsBetween("2026-01-01", "2026-01-31")).resolves.toEqual([]);
    await expect(qb.billPaymentsBetween("2026-01-01", "2026-01-31")).resolves.toEqual([]);
  });

  it("maps QuickBooks rows to cents and refs", async () => {
    getQuickBooks.mockResolvedValue({
      purchasesBetween: async () => [{ Id: "1", TxnDate: "2026-01-02", TotalAmt: 12.34, AccountRef: { value: "35" }, EntityRef: { value: "9" } }],
      billsBetween: async () => [{ Id: "2", TxnDate: "2026-01-03", TotalAmt: 5, VendorRef: { value: "8" } }],
      billPaymentsBetween: async () => [
        { Id: "3", TxnDate: "2026-01-04", TotalAmt: 5, Line: [{ LinkedTxn: [{ TxnId: "2", TxnType: "Bill" }, { TxnId: "2", TxnType: "Bill" }, { TxnId: "7", TxnType: "VendorCredit" }] }] },
      ],
    });
    const qb = await reader();
    await expect(qb.purchasesBetween("2026-01-01", "2026-01-31")).resolves.toEqual([
      { id: "1", txnDate: "2026-01-02", totalCents: 1234, accountRef: "35", vendorRef: "9" },
    ]);
    await expect(qb.billsBetween("2026-01-01", "2026-01-31")).resolves.toEqual([
      { id: "2", txnDate: "2026-01-03", totalCents: 500, accountRef: null, vendorRef: "8" },
    ]);
    await expect(qb.billPaymentsBetween("2026-01-01", "2026-01-31")).resolves.toEqual([{ id: "3", txnDate: "2026-01-04", billIds: ["2"] }]);
  });
});
