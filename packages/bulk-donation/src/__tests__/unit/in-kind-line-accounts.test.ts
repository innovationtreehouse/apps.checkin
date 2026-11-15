import { describe, expect, it } from "vitest";
import { lineAccounts, type LineToBook } from "../../lib/in-kind-accounts";

const QB = [
  { Id: "600", Name: "Supplies", FullyQualifiedName: "Supplies", AccountType: "Expense", Active: true },
  { Id: "610", Name: "Materials", FullyQualifiedName: "Materials", AccountType: "Cost of Goods Sold", Active: true },
  { Id: "150", Name: "Equipment", FullyQualifiedName: "Equipment", AccountType: "Fixed Asset", Active: true },
  { Id: "700", Name: "Old supplies", FullyQualifiedName: "Old supplies", AccountType: "Expense", Active: false },
  { Id: "400", Name: "In-kind income", FullyQualifiedName: "In-kind income", AccountType: "Other Income", Active: true },
];

const NO_ROLES = new Set<string>();

const line = (id: number, over: Partial<LineToBook> = {}): LineToBook => ({ id, description: `Line ${id}`, valueCents: 10_00, gtin13: "0012345678905", quickBooksAccountId: null, ...over });

describe("lineAccounts", () => {
  it("books each line to its rule's account, and a hand-set account over any rule", () => {
    const ruled = new Map([[1, { accountId: "600" }], [2, { accountId: "610" }]]);
    const lines = [line(1), line(2, { quickBooksAccountId: "600" })];
    expect(lineAccounts(lines, new Set(), ruled, QB, NO_ROLES)).toEqual(new Map([[1, "600"], [2, "600"]]));
  });

  it("books donated equipment to a fixed-asset account", () => {
    expect(lineAccounts([line(1)], new Set([1]), new Map([[1, { accountId: "150" }]]), QB, NO_ROLES)).toEqual(new Map([[1, "150"]]));
  });

  it("holds a line with no GTIN-13 and no hand-set account, and one no rule resolves, naming each", () => {
    const ruled = new Map([[2, { reason: "No account rule covers this part" }]]);
    const note = lineAccounts([line(1, { gtin13: null }), line(2)], new Set(), ruled, QB, NO_ROLES);
    expect(note).toMatch(/Line 1: it has no Part ID/);
    expect(note).toMatch(/Line 2: No account rule covers this part/);
    expect(note).toMatch(/set an account/i);
  });

  it("holds a line whose account is of the wrong type for it", () => {
    expect(lineAccounts([line(1)], new Set([1]), new Map([[1, { accountId: "600" }]]), QB, NO_ROLES)).toMatch(/Line 1: .*Supplies is Expense.*Fixed Asset/);
    expect(lineAccounts([line(1, { quickBooksAccountId: "150" })], new Set(), new Map(), QB, NO_ROLES)).toMatch(/Line 1: .*Equipment is Fixed Asset/);
    expect(lineAccounts([line(1, { quickBooksAccountId: "400" })], new Set(), new Map(), QB, NO_ROLES)).toMatch(/Line 1: .*Other Income/);
  });

  it("holds a line whose account a books-map role books to", () => {
    expect(lineAccounts([line(1, { quickBooksAccountId: "600" })], new Set(), new Map(), QB, new Set(["600"]))).toMatch(/Line 1: Supplies is a books-map role's account/);
  });

  it("holds a line whose account is inactive or not in QuickBooks", () => {
    expect(lineAccounts([line(1, { quickBooksAccountId: "700" })], new Set(), new Map(), QB, NO_ROLES)).toMatch(/Line 1: .*Old supplies is inactive/);
    expect(lineAccounts([line(1, { quickBooksAccountId: "999" })], new Set(), new Map(), QB, NO_ROLES)).toMatch(/Line 1: .*999 is not in QuickBooks/);
  });
});
