/**
 * @jest-environment node
 */
import type { IncomeConfig } from "@checkin/income";

// The library's root entry pulls in its generated Prisma client, which the jest env does not build.
const configureIncome = jest.fn<void, [IncomeConfig]>();
const roleAccounts = jest.fn();
jest.mock("@checkin/income", () => ({
  BANK_ROLE: { shopify: "SHOPIFY_BANK", benevity: "BENEVITY_BANK" },
  SHOPIFY_LINE_ROLES: { income: "SHOPIFY_SALES", charge_remainder: "SHOPIFY_CHARGE_REMAINDER", fees: "SHOPIFY_FEES", adjustments: "SHOPIFY_ADJUSTMENTS" },
  roleAccounts,
  configureIncome,
  mirrorPayoutStatus: (s: string) => s.toLowerCase(),
  mirrorSource: () => "api",
  toQbDeposit: jest.fn(),
}));
jest.mock("@/lib/components/host", () => ({ getOrg: jest.fn(), getPrincipal: jest.fn() }));
jest.mock("@/lib/shopifyRead/client", () => ({ isConfigured: () => false }));
const getQuickBooks = jest.fn();
const buildQuickBooks = jest.fn();
jest.mock("@/lib/quickbooks/client", () => ({ getQuickBooks, buildQuickBooks }));

async function config(): Promise<IncomeConfig> {
  await jest.isolateModulesAsync(async () => {
    (await import("../configure")).configureRuntime();
  });
  return configureIncome.mock.calls.at(-1)![0];
}

const ENV = { ...process.env };
beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  process.env = { ...ENV };
});

describe("income QuickBooks Class binding", () => {
  it("is unbound without a QuickBooks realm", async () => {
    delete process.env.QBO_REALM_ID;
    expect((await config()).classes).toBeUndefined();
  });

  it("answers only the active Classes", async () => {
    process.env.QBO_REALM_ID = "123";
    getQuickBooks.mockResolvedValue({
      classes: async () => [
        { Id: "1", Name: "Camp", FullyQualifiedName: "Camp", Active: true },
        { Id: "2", Name: "Old", FullyQualifiedName: "Old", Active: false },
        { Id: "3", Name: "Shop", FullyQualifiedName: "Shop" },
      ],
    });
    await expect((await config()).classes!.activeClassIds()).resolves.toEqual(["1", "3"]);
  });

  it("throws while QuickBooks is off, so an assignment is refused", async () => {
    process.env.QBO_REALM_ID = "123";
    getQuickBooks.mockResolvedValue(null);
    await expect((await config()).classes!.activeClassIds()).rejects.toThrow("QuickBooks is off");
  });
});

describe("income posting binding", () => {
  const client = { bookCloseDate: jest.fn() };

  beforeEach(() => {
    process.env.QBO_REALM_ID = "123";
    delete process.env.INCOME_MIRROR_NEWEST_WINS;
    buildQuickBooks.mockReturnValue(client);
  });

  it("binds the guarded client, creation gated", async () => {
    expect((await config()).posting).toEqual({ client, mirrorNewestWins: false });
  });

  it("opens creation only when the mirror is newest-wins", async () => {
    process.env.INCOME_MIRROR_NEWEST_WINS = "true";
    expect((await config()).posting?.mirrorNewestWins).toBe(true);
  });

  it("is unbound without a QuickBooks realm", async () => {
    delete process.env.QBO_REALM_ID;
    expect((await config()).posting).toBeUndefined();
    expect(buildQuickBooks).not.toHaveBeenCalled();
  });

  it("is unbound when the guard refuses the company", async () => {
    buildQuickBooks.mockReturnValue(null);
    expect((await config()).posting).toBeUndefined();
  });

  it("names what posting still lacks, counting the Shopify roles as the drain resolves them", async () => {
    const { incomePostingMissing } = await import("../configure");
    roleAccounts.mockResolvedValue({ SHOPIFY_BANK: "1", SHOPIFY_SALES: "2", SHOPIFY_FEES: "3" });
    await expect(incomePostingMissing()).resolves.toEqual([
      "Shopify mirror",
      "the switch INCOME_MIRROR_NEWEST_WINS=true",
      "no account picked for: Shopify: card remainder, Shopify: adjustments",
    ]);
    delete process.env.QBO_REALM_ID;
    roleAccounts.mockResolvedValue({ SHOPIFY_BANK: "1", SHOPIFY_SALES: "2", SHOPIFY_CHARGE_REMAINDER: "3", SHOPIFY_FEES: "4", SHOPIFY_ADJUSTMENTS: "5" });
    await expect(incomePostingMissing()).resolves.toEqual(["QuickBooks company (QBO_REALM_ID)", "Shopify mirror", "the switch INCOME_MIRROR_NEWEST_WINS=true"]);
  });
});

describe("Benevity posting readiness", () => {
  it("names every Benevity role the books map leaves unset", async () => {
    const { benevityPostingMissing } = await import("../configure");
    process.env.QBO_REALM_ID = "123";
    roleAccounts.mockResolvedValue({ BENEVITY_BANK: "1", BENEVITY_DONATIONS: "2" });
    await expect(benevityPostingMissing()).resolves.toEqual(["no account picked for: Benevity: employer matches, Benevity: fees"]);

    delete process.env.QBO_REALM_ID;
    roleAccounts.mockResolvedValue({ BENEVITY_BANK: "1", BENEVITY_DONATIONS: "2", BENEVITY_MATCHES: "3", BENEVITY_FEES: "4" });
    await expect(benevityPostingMissing()).resolves.toEqual(["QuickBooks company (QBO_REALM_ID)"]);
  });
});
