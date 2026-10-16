/**
 * @jest-environment node
 */
import type { BulkDonationConfig } from "@inventory/bulk-donation";

// The library's root entry pulls in its generated Prisma client, which the jest env does not build.
const configureBulkDonation = jest.fn<void, [BulkDonationConfig]>();
jest.mock("@inventory/bulk-donation", () => ({ configureBulkDonation }));
const ORG = { id: "treehouse", name: "Treehouse" };
jest.mock("@/lib/catalog/configure", () => ({ getOrg: async () => ORG, getPrincipal: jest.fn() }));
const searchItems = jest.fn();
const getItem = jest.fn();
jest.mock("@inventory/global-catalog", () => ({ readService: { searchItems, getItem }, referenceMatchingService: {} }));
const applyDonation = jest.fn();
jest.mock("@/lib/workflowMapping/inventorySink", () => ({ inventoryReceipts: () => ({ applyDonation }) }));
const incomeClaimedDepositIds = jest.fn();
jest.mock("@inventory/income", () => ({ incomeClaimedDepositIds }));
const getQuickBooks = jest.fn();
jest.mock("@/lib/quickbooks/client", () => ({ getQuickBooks }));

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

  it("X11 refuses a receipt key and another org's delta", async () => {
    const { inventory } = await config();
    const lineItems = [{ lineItemId: 1, gtin13: "0011111111116", quantityDelta: 1, isDelayed: false, conversionFactor: 1, conversionVersion: 1 }];

    await expect(inventory!.apply({ receiptId: "receipt:abc", orgId: ORG.id, retailer: null, lineItems })).rejects.toThrow("donation:<id>");
    await expect(inventory!.apply({ receiptId: "donation:1", orgId: "other", retailer: null, lineItems })).rejects.toThrow("orgId");
    expect(applyDonation).not.toHaveBeenCalled();
  });

  it("leaves the QuickBooks drain unbound without a realm and a donation bank account", async () => {
    delete process.env.QBO_REALM_ID;
    process.env.QBO_DONATION_BANK_ACCOUNT_ID = "35";
    expect((await config()).qb).toBeUndefined();
    process.env.QBO_REALM_ID = "123";
    delete process.env.QBO_DONATION_BANK_ACCOUNT_ID;
    expect((await config()).qb).toBeUndefined();
  });

  it("binds the drain to checkin's one guarded client and the donation bank account", async () => {
    process.env.QBO_REALM_ID = "123";
    process.env.QBO_DONATION_BANK_ACCOUNT_ID = "35";
    process.env.CHECKIN_ENV = "dev";
    const client = { env: "sandbox" };
    getQuickBooks.mockResolvedValue(client);

    const { qb } = await config();

    expect(qb).toMatchObject({ bankAccountId: "35", prod: false });
    await expect(qb!.client()).resolves.toBe(client);
  });

  it("keeps deposits income holds out of donation matching", async () => {
    incomeClaimedDepositIds.mockResolvedValue(["501"]);
    const { otherLaneClaims } = await config();
    await expect(otherLaneClaims!.claimedDepositIds(ORG.id)).resolves.toEqual(["501"]);
    expect(incomeClaimedDepositIds).toHaveBeenCalledWith(ORG.id);
  });
});
