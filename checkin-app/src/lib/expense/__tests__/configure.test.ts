import type { ExpensePosting, Outbound, PeopleDirectory, QbReader, QbRefs, QbVendors, SignoffDirectory } from "@checkin/expense";

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
const configureExpense = jest.fn<void, [{ signoff: SignoffDirectory; people: PeopleDirectory; quickbooks: { reader: QbReader; refs: QbRefs; vendors: QbVendors; posting: () => Promise<ExpensePosting | null> }; outbound: Outbound }]>();
const reimburseeVendorId = jest.fn();
class QuickBooksNotConnectedError extends Error {}
jest.mock("@checkin/expense", () => ({ configureExpense, reimburseeVendorId, QuickBooksNotConnectedError }));
const createVendor = jest.fn();
jest.mock("@checkin/quickbooks", () => ({ createVendor }));
jest.mock("@/lib/components/host", () => ({ getOrg: jest.fn() }));
const getQuickBooks = jest.fn();
jest.mock("@/lib/quickbooks/client", () => ({ getQuickBooks }));
const booksMapAccounts = jest.fn();
jest.mock("@/lib/finance/booksMap", () => ({ booksMap: { accounts: booksMapAccounts } }));
const notifyFinanceAlert = jest.fn();
jest.mock("@/lib/emailRecipients", () => ({ notifyFinanceAlert }));

const NOT_DENIED = { NOT: { household: { orgMembership: { status: "DENIED" } } } };

async function signoff(): Promise<SignoffDirectory> {
  await jest.isolateModulesAsync(async () => {
    (await import("../configure")).configureRuntime();
  });
  return configureExpense.mock.calls.at(-1)![0].signoff;
}

beforeEach(() => jest.clearAllMocks());

it("binds the library's outbound port to checkin's gateway", async () => {
  let gateway: unknown;
  await jest.isolateModulesAsync(async () => {
    gateway = (await import("@/security/outbound")).outboundCall;
    (await import("../configure")).configureRuntime();
  });
  expect(configureExpense.mock.calls.at(-1)![0].outbound).toBe(gateway);
});

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

  it("a bucket's owner and treasurers", async () => {
    budgetOwnerFindUnique.mockResolvedValue({
      isOrgLevel: false,
      owner: { id: 7, mergedIntoId: null, household: { orgMembership: { status: "DENIED" } } },
      treasurers: [{ personId: 8 }],
    });
    const dir = await signoff();

    await expect(dir.bucketApprovers(100)).resolves.toEqual({ orgLevel: false, approvers: [8], owner: 7 });
    expect(budgetOwnerFindUnique.mock.calls[0][0].select.treasurers.where.person).toEqual({ mergedIntoId: null, ...NOT_DENIED });
  });

  it("an org-level bucket has no approvers and no owner", async () => {
    budgetOwnerFindUnique.mockResolvedValue({ isOrgLevel: true, owner: { id: 7, mergedIntoId: null, household: null }, treasurers: [{ personId: 8 }] });
    await expect((await signoff()).bucketApprovers(100)).resolves.toEqual({ orgLevel: true, approvers: [], owner: null });
  });

  it("the non-org-level buckets a person owns or treasures, archived ones included", async () => {
    budgetOwnerFindMany.mockResolvedValue([]);
    const dir = await signoff();

    await dir.bucketsApprovedBy(7);

    const { where } = budgetOwnerFindMany.mock.calls[0][0];
    expect(where).toMatchObject({ isOrgLevel: false });
    expect(where).not.toHaveProperty("archivedAt");
    const [owner, treasurer] = where.OR;
    expect(owner).toEqual({ ownerId: 7, owner: { mergedIntoId: null, ...NOT_DENIED } });
    expect(treasurer.treasurers.some).toEqual({ personId: 7, person: { mergedIntoId: null, ...NOT_DENIED } });
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

describe("whether a reimbursee is an adult", () => {
  it.each([
    ["an adult by date of birth", { dateOfBirth: new Date("1980-01-01"), isDeclaredAdult: false }, true],
    ["a declared adult with no date of birth", { dateOfBirth: null, isDeclaredAdult: true }, true],
    ["a minor", { dateOfBirth: new Date(), isDeclaredAdult: false }, false],
    ["someone of unknown age", { dateOfBirth: null, isDeclaredAdult: false }, false],
    ["nobody live", null, false],
  ])("answers for %s", async (_label, row, adult) => {
    personFindFirst.mockResolvedValue(row);
    await expect((await signoff()).isAdult(7)).resolves.toBe(adult);
    expect(personFindFirst.mock.calls[0][0]).toMatchObject({ where: { id: 7, mergedIntoId: null } });
  });
});

describe("expense QuickBooks reader", () => {
  async function reader(): Promise<QbReader> {
    await jest.isolateModulesAsync(async () => {
      (await import("../configure")).configureRuntime();
    });
    return configureExpense.mock.calls.at(-1)![0].quickbooks.reader;
  }

  it("throws 'not connected', never an empty read, while QuickBooks is off", async () => {
    getQuickBooks.mockResolvedValue(null);
    const qb = await reader();
    const reads = [
      qb.purchasesBetween("2026-01-01", "2026-01-31"),
      qb.billsBetween("2026-01-01", "2026-01-31"),
      qb.billPaymentsBetween("2026-01-01", "2026-01-31"),
      qb.purchasesByIds(["1"]),
      qb.billsByIds(["2"]),
      qb.billPaymentsByIds(["3"]),
    ];
    for (const read of reads) await expect(read).rejects.toBeInstanceOf(QuickBooksNotConnectedError);
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

describe("expense posting binding", () => {
  async function ports() {
    await jest.isolateModulesAsync(async () => {
      (await import("../configure")).configureRuntime();
    });
    return configureExpense.mock.calls.at(-1)![0].quickbooks;
  }

  function clientWith(env: string, accountType: string | undefined) {
    return { env, accounts: jest.fn(async () => [{ Id: "41", Name: "Card", FullyQualifiedName: "Card", AccountType: accountType }]) };
  }

  beforeEach(() => booksMapAccounts.mockResolvedValue({ EXPENSE_PAYMENT: "41" }));

  it.each([
    ["Credit Card", "CreditCard"],
    ["Bank", "Cash"],
  ])("binds the guarded client and the books map's account; a %s account pays by %s", async (accountType, paymentType) => {
    const client = clientWith("sandbox", accountType);
    getQuickBooks.mockResolvedValue(client);
    await expect((await ports()).posting()).resolves.toEqual({ client, paymentAccountId: "41", paymentType, prod: false, sweepIncomplete: expect.any(Function) });
  });

  it("takes prod from the client's own environment, not a separate flag", async () => {
    getQuickBooks.mockResolvedValue(clientWith("production", "Bank"));
    await expect((await ports()).posting()).resolves.toMatchObject({ prod: true });
  });

  it("is unbound while the books map has no payment account", async () => {
    booksMapAccounts.mockResolvedValue({});
    await expect((await ports()).posting()).resolves.toBeNull();
    expect(getQuickBooks).not.toHaveBeenCalled();
  });

  it("is unbound while QuickBooks is off", async () => {
    getQuickBooks.mockResolvedValue(null);
    await expect((await ports()).posting()).resolves.toBeNull();
  });

  it.each([
    ["an Expense account", "Expense"],
    ["an account QuickBooks no longer has", undefined],
  ])("is unbound for %s and emails finance once", async (_label, accountType) => {
    getQuickBooks.mockResolvedValue(clientWith("sandbox", accountType));
    const { posting } = await ports();
    await expect(posting()).resolves.toBeNull();
    await expect(posting()).resolves.toBeNull();
    expect(notifyFinanceAlert).toHaveBeenCalledTimes(1);
  });

  it("names what posting lacks for the status page, without emailing finance", async () => {
    const { expensePostingMissing } = await import("../configure");
    getQuickBooks.mockResolvedValue(clientWith("sandbox", "Bank"));
    await expect(expensePostingMissing()).resolves.toEqual([]);
    getQuickBooks.mockResolvedValue(clientWith("sandbox", "Expense"));
    await expect(expensePostingMissing()).resolves.toEqual(["a Bank or Credit Card account for Organisation card (the one picked is a Expense account)"]);
    getQuickBooks.mockResolvedValue(null);
    await expect(expensePostingMissing()).resolves.toEqual(["a QuickBooks connection"]);
    booksMapAccounts.mockResolvedValue({});
    await expect(expensePostingMissing()).resolves.toEqual(["no account picked for: Organisation card"]);
    expect(notifyFinanceAlert).not.toHaveBeenCalled();
  });

  it("emails finance when the daily sweep reads a full page", async () => {
    getQuickBooks.mockResolvedValue(clientWith("sandbox", "Bank"));
    const bound = await (await ports()).posting();
    await bound!.sweepIncomplete({ orgId: "org", since: new Date("2026-10-01T08:00:00Z") });
    expect(notifyFinanceAlert).toHaveBeenCalledTimes(1);
    expect(notifyFinanceAlert.mock.calls[0][1].since).toBe("2026-10-01");
  });

  it("matches Purchases against the same books-map account", async () => {
    await expect((await ports()).refs.paymentAccountId()).resolves.toBe("41");
    booksMapAccounts.mockResolvedValue({});
    await expect((await ports()).refs.paymentAccountId()).resolves.toBeNull();
  });
});
