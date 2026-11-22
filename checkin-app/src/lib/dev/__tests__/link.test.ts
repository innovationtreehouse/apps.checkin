/**
 * @jest-environment node
 */
/**
 * The link step finds each seeded bucket's Class, each books-map role's account, the membership
 * year variants and each program's two products by name, and writes their ids in one transaction.
 * Anything missing fails the step, naming it, and nothing is written. It refuses prod and staging,
 * and on local reads the stand-in lists and leaves Shopify alone.
 */
import { BOOKS_MAP_ROLES } from "@checkin/quickbooks";
import { DevLinkError, linkDevExternalIds } from "@/lib/dev/link";
import { DEV_SEED_ROLE_ACCOUNTS, devSeedProgramHandle } from "@/lib/dev/linkNames";
import { LOCAL_QUICKBOOKS_ACCOUNTS } from "@/lib/finance/booksMap";
import { LOCAL_QUICKBOOKS_CLASSES } from "@/lib/finance/budgetOwners";
import type { AdminProduct } from "@/lib/shopify/products";

const tx = {
    budgetOwner: { update: jest.fn() },
    booksMapRoleAccount: { upsert: jest.fn() },
    membershipYearVariant: { upsert: jest.fn() },
    program: { update: jest.fn() },
};
const env = jest.fn();
const classes = jest.fn();
const accounts = jest.fn();
const refresh = jest.fn();
const products = new Map<string, AdminProduct>();

jest.mock("@/lib/config", () => ({
    config: {
        checkinEnv: () => env(),
        shopifyStoreDomain: () => "dev-store.myshopify.com",
        resendApiKey: () => undefined,
    },
}));
jest.mock("@/lib/finance/quickBooksLists", () => ({ refreshQuickBooksLists: () => refresh() }));
jest.mock("@/lib/finance/budgetOwners", () => ({
    ...jest.requireActual("@/lib/finance/budgetOwners"),
    listQuickBooksClasses: () => classes(),
}));
jest.mock("@/lib/finance/booksMap", () => ({
    ...jest.requireActual("@/lib/finance/booksMap"),
    listQuickBooksAccounts: () => accounts(),
}));
jest.mock("@/lib/shopify/client", () => ({ getAccessToken: async () => "token" }));
jest.mock("@/lib/shopify/products", () => ({
    ...jest.requireActual("@/lib/shopify/products"),
    getProductByHandle: async (_domain: string, _token: string, handle: string) => products.get(handle) ?? null,
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        budgetOwner: { findMany: async () => [{ id: 1, name: "Facility" }, { id: 2, name: "Woodworking 101" }] },
        program: { findMany: async () => [{ id: 7, name: "Woodworking 101" }] },
        boardSettings: { findUniqueOrThrow: async () => ({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) }) },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
}));

const stockDevStore = () => {
    products.set("dev-seed-membership", { id: 100, variants: [{ id: 2025, title: "2025" }, { id: 2026, title: "2026" }, { id: 2027, title: "2027" }] });
    products.set(devSeedProgramHandle("Woodworking 101", "public"), { id: 200, variants: [{ id: 201 }] });
    products.set(devSeedProgramHandle("Woodworking 101", "claimant"), { id: 300, variants: [{ id: 301 }] });
};

beforeEach(() => {
    jest.clearAllMocks();
    products.clear();
    classes.mockResolvedValue(LOCAL_QUICKBOOKS_CLASSES);
    accounts.mockResolvedValue(LOCAL_QUICKBOOKS_ACCOUNTS);
    refresh.mockResolvedValue({ refreshedAt: new Date(), accounts: 1, classes: 1 });
    jest.useFakeTimers({ now: new Date(Date.UTC(2026, 10, 19)) });
});
afterEach(() => jest.useRealTimers());

it("names every role's account in the local stand-in list under a type the role takes", async () => {
    env.mockReturnValue("local");
    await linkDevExternalIds();
    expect(tx.booksMapRoleAccount.upsert).toHaveBeenCalledTimes(BOOKS_MAP_ROLES.length);
    for (const role of BOOKS_MAP_ROLES) {
        const id = LOCAL_QUICKBOOKS_ACCOUNTS.find((a) => a.name === DEV_SEED_ROLE_ACCOUNTS[role])!.id;
        expect(tx.booksMapRoleAccount.upsert).toHaveBeenCalledWith({ where: { role }, create: { role, quickBooksAccountId: id }, update: { quickBooksAccountId: id } });
    }
});

it("links the buckets on local from the stand-ins and leaves Shopify to the mock", async () => {
    env.mockReturnValue("local");
    await expect(linkDevExternalIds()).resolves.toMatch(/Shopify left to the local mock/);
    expect(refresh).not.toHaveBeenCalled();
    expect(tx.budgetOwner.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { quickBooksClassId: "9001" } });
    expect(tx.budgetOwner.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { quickBooksClassId: "9006" } });
    expect(tx.membershipYearVariant.upsert).not.toHaveBeenCalled();
});

it("links the membership years in progress and coming, and both program products, on dev", async () => {
    env.mockReturnValue("dev");
    stockDevStore();
    await linkDevExternalIds();
    expect(refresh).toHaveBeenCalled();
    expect(tx.membershipYearVariant.upsert.mock.calls.map(([a]) => a.create)).toEqual([
        { membershipYear: 2026, shopifyVariantId: "2026" },
        { membershipYear: 2027, shopifyVariantId: "2027" },
    ]);
    expect(tx.program.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { shopifyProductId: "200", shopifyVariantId: "201", claimantShopifyProductId: "300", claimantShopifyVariantId: "301" },
    });
});

it("fails naming each missing object, and writes nothing", async () => {
    env.mockReturnValue("dev");
    stockDevStore();
    products.delete(devSeedProgramHandle("Woodworking 101", "claimant"));
    classes.mockResolvedValue(LOCAL_QUICKBOOKS_CLASSES.filter((c) => c.name !== "Woodworking 101"));
    accounts.mockResolvedValue(LOCAL_QUICKBOOKS_ACCOUNTS.filter((a) => a.name !== "Merchant fees"));
    const failure = linkDevExternalIds();
    await expect(failure).rejects.toThrow(DevLinkError);
    await expect(failure).rejects.toThrow(
        /QuickBooks Class "Woodworking 101".*QuickBooks account "Merchant fees".*SHOPIFY_FEES.*"dev-seed-program-woodworking-101-reserved-seat".*Run the dev sandbox and dev-store setup scripts/,
    );
    for (const model of Object.values(tx)) for (const fn of Object.values(model)) expect(fn).not.toHaveBeenCalled();
});

it("fails when QuickBooks is off on dev", async () => {
    env.mockReturnValue("dev");
    refresh.mockResolvedValue(null);
    await expect(linkDevExternalIds()).rejects.toThrow(/QuickBooks is not connected/);
});

it.each(["prod", "stg"])("refuses %s", async (name) => {
    env.mockReturnValue(name);
    await expect(linkDevExternalIds()).rejects.toThrow(/only on dev and local/);
    expect(refresh).not.toHaveBeenCalled();
});
