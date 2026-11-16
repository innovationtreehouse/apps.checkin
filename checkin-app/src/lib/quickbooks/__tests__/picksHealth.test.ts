/**
 * @jest-environment node
 */
const tryBuildQuickBooks = jest.fn();
jest.mock("@/lib/quickbooks/client", () => ({ tryBuildQuickBooks }));
const listQuickBooksAccounts = jest.fn();
jest.mock("@/lib/finance/booksMap", () => ({ listQuickBooksAccounts }));
// The libraries' root entries pull in their generated Prisma clients, which the jest env does not build.
const expensePicks = jest.fn();
jest.mock("@checkin/expense", () => ({ misTypedQuickBooksPicks: expensePicks }));
const donationPicks = jest.fn();
jest.mock("@checkin/bulk-donation", () => ({ misTypedQuickBooksPicks: donationPicks }));
const incomePicks = jest.fn();
jest.mock("@checkin/income", () => ({ misTypedQuickBooksPicks: incomePicks }));

import { quickBooksPicksCheck } from "../picksHealth";

const COPY = [{ id: "600", name: "Supplies", accountType: "Expense", active: true }];

beforeEach(() => {
    jest.clearAllMocks();
    listQuickBooksAccounts.mockResolvedValue(COPY);
    for (const read of [expensePicks, donationPicks, incomePicks]) read.mockResolvedValue([]);
});
afterEach(() => expect(tryBuildQuickBooks).not.toHaveBeenCalled());

describe("QuickBooks picks: account types", () => {
    it("is green when every library's picks are of an accepted type, reading the copy", async () => {
        expect(await quickBooksPicksCheck()).toMatchObject({ id: "quickbooks-pick-types", ok: true, detail: "Every stored pick is of a type it accepts." });
        for (const read of [expensePicks, donationPicks, incomePicks]) expect(read).toHaveBeenCalledWith(COPY);
    });

    it("is red with every library's lines joined", async () => {
        expensePicks.mockResolvedValue(["Expense accounts, Tools: wrong"]);
        incomePicks.mockResolvedValue(["Income items, variant 42: missing"]);
        expect(await quickBooksPicksCheck()).toMatchObject({ ok: false, detail: "Re-pick: Expense accounts, Tools: wrong; Income items, variant 42: missing." });
    });

    it("reads Not checked while the copy is empty, asking no library", async () => {
        listQuickBooksAccounts.mockResolvedValue([]);
        expect(await quickBooksPicksCheck()).toMatchObject({ ok: true, detail: "Not checked: the QuickBooks lists have not been copied yet." });
        expect(expensePicks).not.toHaveBeenCalled();
    });

    it("is red when a library's read fails", async () => {
        donationPicks.mockRejectedValue(new Error("db down"));
        expect(await quickBooksPicksCheck()).toMatchObject({ ok: false, detail: "Could not read it: db down." });
    });
});
