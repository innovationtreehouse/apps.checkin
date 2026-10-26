/**
 * @jest-environment node
 */
import type { IncomeConfig } from "@checkin/income";

// The library's root entry pulls in its generated Prisma client, which the jest env does not build.
const configureIncome = jest.fn<void, [IncomeConfig]>();
jest.mock("@checkin/income", () => ({
  configureIncome,
  mirrorPayoutStatus: (s: string) => s.toLowerCase(),
  mirrorSource: () => "api",
  toQbDeposit: jest.fn(),
}));
jest.mock("@/lib/catalog/configure", () => ({ getOrg: jest.fn(), getPrincipal: jest.fn() }));
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
  const ACCOUNTS = { income: "10", charge_remainder: "11", fees: "12", adjustments: "13" };
  const client = { bookCloseDate: jest.fn() };

  beforeEach(() => {
    process.env.QBO_REALM_ID = "123";
    process.env.QBO_INCOME_INCOME_ACCOUNT_ID = ACCOUNTS.income;
    process.env.QBO_INCOME_CHARGE_REMAINDER_ACCOUNT_ID = ACCOUNTS.charge_remainder;
    process.env.QBO_INCOME_FEES_ACCOUNT_ID = ACCOUNTS.fees;
    process.env.QBO_INCOME_ADJUSTMENTS_ACCOUNT_ID = ACCOUNTS.adjustments;
    delete process.env.INCOME_MIRROR_NEWEST_WINS;
    buildQuickBooks.mockReturnValue(client);
  });

  it("binds the guarded client and the four accounts, creation gated", async () => {
    expect((await config()).posting).toEqual({ client, accounts: ACCOUNTS, mirrorNewestWins: false });
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

  it("is unbound while any deposit account is unset", async () => {
    delete process.env.QBO_INCOME_FEES_ACCOUNT_ID;
    expect((await config()).posting).toBeUndefined();
  });

  it("is unbound when the guard refuses the company", async () => {
    buildQuickBooks.mockReturnValue(null);
    expect((await config()).posting).toBeUndefined();
  });
});
