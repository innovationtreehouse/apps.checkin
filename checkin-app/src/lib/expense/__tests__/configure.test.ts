import type { PeopleDirectory, QbReader, QbRefs, QbVendors, SignoffDirectory } from "@inventory/expense";

const personRoleFindMany = jest.fn();
const budgetOwnerFindUnique = jest.fn();
const budgetOwnerFindMany = jest.fn();
const personFindUnique = jest.fn();
const personMergeFindUnique = jest.fn();
const personFindFirst = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    personRole: { findMany: personRoleFindMany },
    budgetOwner: { findUnique: budgetOwnerFindUnique, findMany: budgetOwnerFindMany },
    person: { findUnique: personFindUnique, findFirst: personFindFirst },
    personMerge: { findUnique: personMergeFindUnique },
  },
}));

// The library's root entry pulls in its generated Prisma client, which the jest env does not build.
const configureExpense = jest.fn<void, [{ signoff: SignoffDirectory; people: PeopleDirectory; quickbooks: { reader: QbReader; refs: QbRefs; vendors: QbVendors } }]>();
const reimburseeVendorId = jest.fn();
jest.mock("@inventory/expense", () => ({ configureExpense, reimburseeVendorId }));
const createVendor = jest.fn();
jest.mock("@inventory/quickbooks", () => ({ createVendor }));
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

    await expect(dir.bucketApprovers(100)).resolves.toEqual({ orgLevel: false, approvers: [8], leader: 7 });
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

describe("the live person an id resolves to", () => {
  const people: Record<number, { id: number; mergedIntoId: number | null }> = {
    1: { id: 1, mergedIntoId: 2 },
    2: { id: 2, mergedIntoId: null },
    5: { id: 5, mergedIntoId: 5 },
  };
  const archive: Record<number, { toId: number }> = { 3: { toId: 1 } };
  beforeEach(() => {
    personFindUnique.mockImplementation(async ({ where }: { where: { id: number } }) => people[where.id] ?? null);
    personMergeFindUnique.mockImplementation(async ({ where }: { where: { fromId: number } }) => archive[where.fromId] ?? null);
  });

  it("is the person when live, the survivor through a tombstone or an archived merge, else null", async () => {
    const dir = await signoff();
    await expect(dir.livePersonFor(2)).resolves.toBe(2);
    await expect(dir.livePersonFor(1)).resolves.toBe(2);
    await expect(dir.livePersonFor(3)).resolves.toBe(2);
    await expect(dir.livePersonFor(4)).resolves.toBeNull();
  });

  it("stops on a cyclic merge chain", async () => {
    await expect((await signoff()).livePersonFor(5)).resolves.toBeNull();
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
    await expect(qb.purchasesByIds(["1"])).resolves.toEqual([]);
    await expect(qb.billsByIds(["2"])).resolves.toEqual([]);
    await expect(qb.billPaymentsByIds(["3"])).resolves.toEqual([]);
  });

  it("maps by-id rows: a Bill's balance and linked BillPayments", async () => {
    getQuickBooks.mockResolvedValue({
      purchasesByIds: async () => [{ Id: "1", TxnDate: "2026-01-02", TotalAmt: 1 }],
      billsByIds: async () => [
        { Id: "2", TxnDate: "2026-01-03", TotalAmt: 5, Balance: 0, LinkedTxn: [{ TxnId: "3", TxnType: "BillPayment" }, { TxnId: "3", TxnType: "BillPayment" }, { TxnId: "9", TxnType: "PurchaseOrder" }] },
        { Id: "4", TxnDate: "2026-01-03", TotalAmt: 5 },
      ],
      billPaymentsByIds: async () => [{ Id: "3", TxnDate: "2026-01-04", TotalAmt: 5 }],
    });
    const qb = await reader();
    await expect(qb.purchasesByIds(["1"])).resolves.toEqual([{ id: "1", txnDate: "2026-01-02", totalCents: 100, accountRef: null, vendorRef: null }]);
    await expect(qb.billsByIds(["2", "4"])).resolves.toEqual([
      { id: "2", txnDate: "2026-01-03", balance: 0, paymentIds: ["3"] },
      { id: "4", txnDate: "2026-01-03", balance: null, paymentIds: [] },
    ]);
    await expect(qb.billPaymentsByIds(["3"])).resolves.toEqual([{ id: "3", txnDate: "2026-01-04" }]);
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

describe("expense reimbursee Vendor ports", () => {
  async function ports() {
    await jest.isolateModulesAsync(async () => {
      (await import("../configure")).configureRuntime();
    });
    return configureExpense.mock.calls.at(-1)![0];
  }

  it("opens no Vendor client while QuickBooks is off", async () => {
    getQuickBooks.mockResolvedValue(null);
    await expect((await ports()).quickbooks.vendors.open()).resolves.toBeNull();
  });

  it("searches, reads by id and finds or creates through the guarded client", async () => {
    const qb = {
      vendorsMatching: jest.fn(async () => [{ Id: "3", DisplayName: "Pat Lee" }]),
      vendorById: jest.fn(async (id: string) => (id === "3" ? { Id: "3", DisplayName: "Pat Lee" } : null)),
    };
    getQuickBooks.mockResolvedValue(qb);
    createVendor.mockResolvedValue({ kind: "found", via: "name", id: "61", displayName: "Pat Lee (Vendor)" });
    const vendors = (await (await ports()).quickbooks.vendors.open())!;

    await expect(vendors.search("Pat")).resolves.toEqual([{ id: "3", displayName: "Pat Lee" }]);
    await expect(vendors.byId("3")).resolves.toEqual({ id: "3", displayName: "Pat Lee" });
    await expect(vendors.byId("4")).resolves.toBeNull();
    await expect(vendors.findOrCreate("Pat Lee", "k")).resolves.toEqual({ id: "61", displayName: "Pat Lee (Vendor)", created: false });
    expect(createVendor).toHaveBeenCalledWith(qb, "Pat Lee", "k");
  });

  it("matches a Bill against the reimbursee's linked Vendor", async () => {
    expect((await ports()).quickbooks.refs.vendorIdFor).toBe(reimburseeVendorId);
  });

  it("names a live person", async () => {
    personFindFirst.mockResolvedValue({ name: "Pat Lee" });
    await expect((await ports()).people.nameOf(9)).resolves.toBe("Pat Lee");
    expect(personFindFirst.mock.calls[0][0].where).toEqual({ id: 9, mergedIntoId: null });
  });
});
