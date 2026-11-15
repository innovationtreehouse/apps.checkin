/**
 * @jest-environment node
 */
/**
 * Integration tier for the copy of QuickBooks' lists: a refresh replaces both rows together,
 * a failed read leaves both rows as they were, and the status read counts each list's entries.
 */
import prisma from "@/lib/prisma";
import { quickBooksListsStatus, refreshQuickBooksLists, savedQuickBooksAccounts, savedQuickBooksClasses } from "@/lib/finance/quickBooksLists";
import { getQuickBooks } from "@/lib/quickbooks/client";

jest.mock("@/lib/quickbooks/client", () => ({ getQuickBooks: jest.fn() }));

type Client = Awaited<ReturnType<typeof getQuickBooks>>;
const client = (accounts: () => Promise<unknown[]>, classes: () => Promise<unknown[]>) =>
    jest.mocked(getQuickBooks).mockResolvedValue({ accounts, classes } as unknown as Client);

const env = process.env.CHECKIN_ENV;
const clean = () => prisma.quickBooksList.deleteMany({ where: { list: { in: ["account", "class"] } } });

beforeEach(async () => {
    process.env.CHECKIN_ENV = "prod";
    await clean();
});
afterAll(async () => {
    process.env.CHECKIN_ENV = env;
    await clean();
});

describe("refreshQuickBooksLists (integration)", () => {
    test("replaces both rows with one refresh time", async () => {
        client(async () => [{ Id: "1", FullyQualifiedName: "Checking", AccountType: "Bank" }], async () => [{ Id: "9", FullyQualifiedName: "Facility" }]);
        await refreshQuickBooksLists();
        client(async () => [{ Id: "2", FullyQualifiedName: "Savings", AccountType: "Bank" }], async () => [{ Id: "8", FullyQualifiedName: "Operations", Active: false }]);
        await refreshQuickBooksLists();

        await expect(savedQuickBooksAccounts()).resolves.toEqual([{ id: "2", name: "Savings", accountType: "Bank", active: true }]);
        await expect(savedQuickBooksClasses()).resolves.toEqual([{ id: "8", name: "Operations", active: false }]);
        const rows = await prisma.quickBooksList.findMany({ select: { refreshedAt: true } });
        expect(rows).toHaveLength(2);
        expect(rows[0].refreshedAt.getTime()).toBe(rows[1].refreshedAt.getTime());
    });

    test("a failed read leaves both rows as they were", async () => {
        client(async () => [{ Id: "1", FullyQualifiedName: "Checking", AccountType: "Bank" }], async () => [{ Id: "9", FullyQualifiedName: "Facility" }]);
        await refreshQuickBooksLists();
        const before = await prisma.quickBooksList.findMany({ orderBy: { list: "asc" } });

        client(async () => [{ Id: "2", FullyQualifiedName: "Savings", AccountType: "Bank" }], async () => { throw new Error("QuickBooks query failed"); });
        await expect(refreshQuickBooksLists()).rejects.toThrow("QuickBooks query failed");

        await expect(prisma.quickBooksList.findMany({ orderBy: { list: "asc" } })).resolves.toEqual(before);
    });

    test("the status read gives each list's refresh time and entry count, and nothing before the first refresh", async () => {
        await expect(quickBooksListsStatus()).resolves.toEqual([]);
        client(
            async () => [{ Id: "1", FullyQualifiedName: "Checking", AccountType: "Bank" }, { Id: "2", FullyQualifiedName: "Savings", AccountType: "Bank" }],
            async () => [{ Id: "9", FullyQualifiedName: "Facility" }],
        );
        const refreshed = await refreshQuickBooksLists();
        await expect(quickBooksListsStatus()).resolves.toEqual([
            { list: "account", refreshedAt: refreshed?.refreshedAt, entries: 2 },
            { list: "class", refreshedAt: refreshed?.refreshedAt, entries: 1 },
        ]);
    });
});
