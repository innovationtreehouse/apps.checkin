/**
 * @jest-environment node
 */
import type { BulkDonationConfig } from "@checkin/bulk-donation";

// The library's root entry pulls in its generated Prisma client, which the jest env does not build.
const configureBulkDonation = jest.fn<void, [BulkDonationConfig]>();
const IN_KIND_ROLES = ["INKIND_INCOME", "INKIND_EXPENSE", "FIXED_ASSETS", "INKIND_CLEARING"];
const inKindAccountsReady = jest.fn();
jest.mock("@checkin/bulk-donation", () => ({ configureBulkDonation, IN_KIND_ROLES, inKindAccountsReady }));
const ORG = { id: "treehouse", name: "Treehouse" };
jest.mock("@/lib/components/host", () => ({ getOrg: async () => ORG, getPrincipal: jest.fn() }));
const searchItems = jest.fn();
const getItem = jest.fn();
jest.mock("@checkin/global-catalog", () => ({ readService: { searchItems, getItem }, referenceMatchingService: {} }));
const applyDonation = jest.fn();
const expectDeposit = jest.fn();
const depositStatus = jest.fn();
jest.mock("@checkin/income", () => ({ expectDeposit, depositStatus }));
const getQuickBooks = jest.fn();
jest.mock("@/lib/quickbooks/client", () => ({ getQuickBooks }));
// local-inventory's root entry pulls in its generated Prisma client too; only the GTIN check and apply are used here.
jest.mock("@checkin/local-inventory", () => ({
  inventoryApply: { applyDonation },
  isProvisionalGtin13: (g: string) => g.startsWith("0200") && g.substring(6, 8) === "27",
}));
const signoff = {
  financeHolders: jest.fn(),
  boardMembers: jest.fn(),
  bucketsApprovedBy: jest.fn(),
};
jest.mock("@/lib/expense/configure", () => ({ signoff }));
const getExpenseSettings = jest.fn();
const donatedAssetLineIds = jest.fn();
jest.mock("@checkin/expense", () => ({ getExpenseSettings, donatedAssetLineIds }));
const booksMap = { accounts: jest.fn(), classes: jest.fn() };
jest.mock("@/lib/finance/booksMap", () => ({ booksMap }));
const notifyFinanceAlert = jest.fn();
jest.mock("@/lib/emailRecipients", () => ({ notifyFinanceAlert }));

async function config(): Promise<BulkDonationConfig> {
  await jest.isolateModulesAsync(async () => {
    (await import("../configure")).configureRuntime();
  });
  return configureBulkDonation.mock.calls.at(-1)![0];
}

const ENV = { ...process.env };
beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  process.env = { ...ENV };
});

describe("bulk-donation wiring", () => {
  it("binds X10 to the catalog's search and item reads", async () => {
    const { catalog } = await config();
    searchItems.mockResolvedValue([{ gtin13: "0011111111116", name: "Cordless Drill" }]);
    getItem.mockResolvedValue({ gtin13: "0011111111116", name: "Cordless Drill", categoryId: 1, subcategoryId: 2 });

    await expect(catalog!.search("drill")).resolves.toEqual([{ gtin13: "0011111111116", name: "Cordless Drill" }]);
    await expect(catalog!.getItem("0011111111116")).resolves.toMatchObject({ name: "Cordless Drill" });
    expect(searchItems).toHaveBeenCalledWith("drill");
  });

  it("binds X11 to local-inventory's donation apply, keyed by the donation id", async () => {
    const { inventory } = await config();
    await inventory!.apply({
      receiptId: "donation:42",
      orgId: ORG.id,
      retailer: null,
      lineItems: [{ lineItemId: 7, gtin13: "0011111111116", quantityDelta: 3, isDelayed: false, conversionFactor: 1, conversionVersion: 1 }],
    });

    expect(applyDonation).toHaveBeenCalledWith(ORG.id, "42", [
      { gtin13: "0011111111116", quantityDelta: 3, conversionFactor: 1, conversionVersion: 1 },
    ]);
  });

  it("X11 marks a provisional GTIN's line so its stock merges once the catalog resolves it", async () => {
    const { inventory } = await config();
    const PROVISIONAL = "0200002700016";
    await inventory!.apply({
      receiptId: "donation:42",
      orgId: ORG.id,
      retailer: null,
      lineItems: [
        { lineItemId: 7, gtin13: PROVISIONAL, quantityDelta: 2, isDelayed: false, conversionFactor: 1, conversionVersion: 1, provisionalName: "Odd clamp" },
        { lineItemId: 8, gtin13: "0011111111116", quantityDelta: 1, isDelayed: false, conversionFactor: 1, conversionVersion: 1, provisionalName: "Drill" },
      ],
    });

    expect(applyDonation).toHaveBeenCalledWith(ORG.id, "42", [
      { gtin13: PROVISIONAL, quantityDelta: 2, conversionFactor: 1, conversionVersion: 1, isProvisional: true, provisionalName: "Odd clamp" },
      { gtin13: "0011111111116", quantityDelta: 1, conversionFactor: 1, conversionVersion: 1 },
    ]);
  });

  it("binds the in-kind accept step's roles and buckets to the expense sign-off directory and its capital review line threshold", async () => {
    const { inKind } = await config();
    signoff.financeHolders.mockResolvedValue([10]);
    signoff.bucketsApprovedBy.mockResolvedValue([4]);
    getExpenseSettings.mockResolvedValue({ capitalLineItemThresholdCents: 50_000 });

    await expect(inKind!.financeHolders()).resolves.toEqual([10]);
    await expect(inKind!.bucketsApprovedBy(3)).resolves.toEqual([4]);
    await expect(inKind!.largeValueCents()).resolves.toBe(50_000);
    expect(getExpenseSettings).toHaveBeenCalledWith(ORG.id);
  });

  it("passes an off capital review line threshold through to bulk donation as 0", async () => {
    const { inKind } = await config();
    getExpenseSettings.mockResolvedValue({ capitalLineItemThresholdCents: 0 });

    await expect(inKind!.largeValueCents()).resolves.toBe(0);
  });

  it("X11 refuses a receipt key and another org's delta", async () => {
    const { inventory } = await config();
    const lineItems = [{ lineItemId: 1, gtin13: "0011111111116", quantityDelta: 1, isDelayed: false, conversionFactor: 1, conversionVersion: 1 }];

    await expect(inventory!.apply({ receiptId: "receipt:abc", orgId: ORG.id, retailer: null, lineItems })).rejects.toThrow("donation:<id>");
    await expect(inventory!.apply({ receiptId: "donation:1", orgId: "other", retailer: null, lineItems })).rejects.toThrow("orgId");
    expect(applyDonation).not.toHaveBeenCalled();
  });

  it("names what the hand-over to income lacks, for the status page: only the realm; income's books map holds the bank", async () => {
    const { donationPostingMissing } = await import("../configure");
    delete process.env.QBO_REALM_ID;
    expect(donationPostingMissing()).toEqual(["QuickBooks company (QBO_REALM_ID)"]);
    process.env.QBO_REALM_ID = "123";
    expect(donationPostingMissing()).toEqual([]);
  });

  it("names what gift-of-goods posting lacks, from the books map the drain reads", async () => {
    const { inKindPostingMissing } = await import("../configure");
    delete process.env.QBO_REALM_ID;
    booksMap.accounts.mockResolvedValue({ INKIND_INCOME: "400", INKIND_EXPENSE: "401" });
    await expect(inKindPostingMissing()).resolves.toEqual([
      "QuickBooks company (QBO_REALM_ID)",
      "no account picked for: Gifts of goods: fixed assets (donated equipment), Gifts of goods: clearing account (finance's past bookings)",
    ]);
    process.env.QBO_REALM_ID = "123";
    booksMap.accounts.mockResolvedValue({ INKIND_INCOME: "400", INKIND_EXPENSE: "401", FIXED_ASSETS: "402", INKIND_CLEARING: "35" });
    inKindAccountsReady.mockReturnValue(false);
    await expect(inKindPostingMissing()).resolves.toEqual(["a Gifts of goods: clearing account (finance's past bookings) that no other lane books to"]);
    expect(inKindAccountsReady).toHaveBeenLastCalledWith(expect.objectContaining({ INKIND_CLEARING: "35" }));
    inKindAccountsReady.mockReturnValue(true);
    await expect(inKindPostingMissing()).resolves.toEqual([]);
  });

  it("leaves income's intake ports unbound without a realm, so nothing is handed over", async () => {
    delete process.env.QBO_REALM_ID;
    expect((await config()).deposits).toBeUndefined();
  });

  it("binds income's intake ports for Benevity", async () => {
    process.env.CHECKIN_ENV = "dev";
    process.env.QBO_REALM_ID = "123";
    const { deposits } = await config();
    const expected = { txnDate: "2026-10-01", netCents: 100, bankRole: "BENEVITY_BANK" as const, lines: [{ role: "BENEVITY_DONATIONS" as const, budgetOwnerId: null, amountCents: 100 }] };
    depositStatus.mockResolvedValue({ D1: { state: "waiting" } });

    expect(deposits!.prod).toBe(false);
    await deposits!.expectDeposit(ORG.id, "D1", expected);
    await expect(deposits!.depositStatus(ORG.id, ["D1"])).resolves.toEqual({ D1: { state: "waiting" } });

    expect(expectDeposit).toHaveBeenCalledWith(ORG.id, "benevity", "D1", expected);
    expect(depositStatus).toHaveBeenCalledWith(ORG.id, "benevity", ["D1"]);

    await deposits!.handOverFailing([{ disbursementId: "D1", reason: "it has no disbursement date" }, { disbursementId: "D2", reason: "it nets to zero or less, so no deposit is due" }]);
    expect(notifyFinanceAlert.mock.calls[0][0]).toBe("finance.donationDepositHandOver");
    expect(notifyFinanceAlert.mock.calls[0][1].batches).toBe("D1: it has no disbursement date; D2: it nets to zero or less, so no deposit is due");
  });

  it("binds the in-kind drain to the guarded client and the books map wherever a realm is set", async () => {
    delete process.env.QBO_REALM_ID;
    expect((await config()).inKindQb).toBeUndefined();
    process.env.QBO_REALM_ID = "123";
    const client = { env: "sandbox" };
    getQuickBooks.mockResolvedValue(client);
    booksMap.accounts.mockResolvedValue({ INKIND_INCOME: "400" });
    booksMap.classes.mockResolvedValue(new Map([[1, "7"]]));

    const { inKindQb } = await config();

    await expect(inKindQb!.client()).resolves.toBe(client);
    await expect(inKindQb!.booksMap.accounts()).resolves.toEqual({ INKIND_INCOME: "400" });
    await expect(inKindQb!.booksMap.classes()).resolves.toEqual(new Map([[1, "7"]]));
    await inKindQb!.sweepIncomplete({ orgId: ORG.id, since: new Date("2026-10-01T08:00:00Z") });
    expect(notifyFinanceAlert.mock.calls[0][0]).toBe("finance.inKindSweepIncomplete");
    expect(notifyFinanceAlert.mock.calls[0][1].since).toBe("2026-10-01");
  });

  it("reads which donated lines became assets from the expense library's capital review", async () => {
    donatedAssetLineIds.mockResolvedValue([3]);
    const { capital } = await config();
    await expect(capital!.assetLineIds(ORG.id, { giftSource: "receipt", giftId: 9 })).resolves.toEqual([3]);
    expect(donatedAssetLineIds).toHaveBeenCalledWith(ORG.id, { giftSource: "receipt", giftId: 9 });
  });
});
