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
jest.mock("@/lib/quickbooks/client", () => ({ getQuickBooks }));

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
