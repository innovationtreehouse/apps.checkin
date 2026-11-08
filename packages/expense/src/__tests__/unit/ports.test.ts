/** Crossing guards and inert adapters — no database. */
import { describe, it, expect, vi } from "vitest";
import { isServiceError, kindOf } from "@checkin/component-kit";
import { callerId } from "../../lib/caller";
import { assertOrg, getExpenseRuntime } from "../../runtime";
import { inertOutbound, inertOwnerDirectory, QuickBooksNotConnectedError } from "../../contract";
import { reimbursementStatus } from "../../services/reimbursementStatus";
import { approveLine } from "../../services/approvalService";
import { resolveDonatedPartAccounts } from "../../services/donatedPartAccounts";
import { lookupCatalogInfo } from "../../lib/expense-qb-processor";
import { qbPostingOnAt } from "../../lib/expense-qb-poster";
import { donatedAssetLineIds, giftsAwaitingCapitalReview } from "../../services/donatedCapitalService";
import { FLAG_AUDIENCE, FLAG_KINDS, RETIRED_FLAG_KINDS, isFlagKind, taxNeedsFinance, type StoredReceiptReview } from "../../lib/flags";
import { finance } from "../../routes";
import { bindPorts, catalogResolving, ORG, principal } from "../helpers/seed";

/** What the catalog client throws when its configured database does not exist. */
const catalogDbMissing = () => Object.assign(new Error("Database does not exist"), { code: "P1003" });

/** A NotWiredError from a second copy of component-kit, as a built app can load: the kit's brand and name, another class. */
const foreignNotWired = (port: string) =>
  Object.assign(new Error(`${port} is not wired`), { name: "NotWiredError", kind: "settings", [Symbol.for("@checkin/component-kit/KindedError")]: true });

describe("callerId", () => {
  it("returns an integer id", () => {
    expect(callerId({ id: 12 })).toBe(12);
  });

  it.each([undefined, null, { id: undefined }, { id: "12" }, { id: 1.5 }])("is a 401 for %j", (p) => {
    expect(() => callerId(p as never)).toThrow(expect.objectContaining({ status: 401 }));
  });

  it("an id-less session cannot approve, before any query runs", async () => {
    await expect(approveLine({ id: undefined, name: null, isFinance: true, isBoard: false } as never, "e", 1, "x")).rejects.toMatchObject({ status: 401 });
  });
});

describe("runtime", () => {
  it("binds inert adapters for every unbound port", async () => {
    const rt = getExpenseRuntime();
    expect(await inertOwnerDirectory.list()).toEqual([]);
    expect(await rt.signoff.bucketApprovers(1)).toEqual({ orgLevel: false, approvers: [], owner: null });
    const notConnected = await rt.quickbooks.reader.purchasesBetween("2026-01-01", "2026-01-31").catch((err: unknown) => err);
    expect(notConnected).toBeInstanceOf(QuickBooksNotConnectedError);
    // Branded, so a route in another chunk still answers 503.
    expect(isServiceError(notConnected) && notConnected.status).toBe(503);
    await expect(rt.quickbooks.posting()).resolves.toBeNull();
  });

  it("an unbound catalog says it is not wired, never \"no match\"", async () => {
    const { catalog } = getExpenseRuntime();
    const calls = [
      catalog.listCategories(),
      catalog.listSubcategories(),
      catalog.getItem("0000000000017"),
      catalog.getActiveItem("0000000000017"),
      catalog.getItemNames(["0000000000017"]),
      catalog.lookupItems("Acme", [{ index: 1, partNumber: "P1" }]),
      getExpenseRuntime().catalogEvents.eventsSince("org", 0),
    ];
    for (const call of calls) expect(kindOf(await call.catch((err: unknown) => err))).toBe("settings");
  });

  it("the mapping catalog route answers an unbound catalog with 503 \"No catalog is connected\"", async () => {
    const ctx = { req: new Request("http://test/api/expense/mapping-catalog"), params: {}, principal: principal(3, { isFinance: true }) };
    await expect(finance.mappingCatalog(ctx)).rejects.toMatchObject({ status: 503, message: "No catalog is connected" });
  });

  it("matching carries on without the catalog and records that it is not connected", async () => {
    const line = { id: 1, partNumber: "P1", manufacturer: null, description: "drill", nonInventory: false };
    expect(await lookupCatalogInfo([line], "Acme")).toEqual({ gtin13ByItemId: new Map(), info: new Map(), catalogNotConnected: true });
    expect(await resolveDonatedPartAccounts(ORG, [{ lineId: 7, gtin13: "0000000000017", isCapital: false }])).toEqual([
      { lineId: 7, reason: "catalog not connected" },
    ]);
  });

  it("an unbound catalog from another copy of the kit still reads as not connected", async () => {
    const unbound = async () => { throw foreignNotWired("catalog"); };
    bindPorts({ catalog: { ...catalogResolving({}), listCategories: unbound } });
    const ctx = { req: new Request("http://test/api/expense/mapping-catalog"), params: {}, principal: principal(3, { isFinance: true }) };
    await expect(finance.mappingCatalog(ctx)).rejects.toMatchObject({ status: 503, message: "No catalog is connected" });
    const line = { id: 1, partNumber: "P1", manufacturer: null, description: "drill", nonInventory: false };
    expect(await lookupCatalogInfo([line], "Acme")).toEqual({ gtin13ByItemId: new Map(), info: new Map(), catalogNotConnected: true });
    expect(await resolveDonatedPartAccounts(ORG, [{ lineId: 7, gtin13: "0000000000017", isCapital: false }])).toEqual([
      { lineId: 7, reason: "catalog not connected" },
    ]);
  });

  it("the mapping catalog route answers a missing catalog database with 503 naming who fixes it", async () => {
    bindPorts({ catalog: { ...catalogResolving({}), listCategories: async () => { throw catalogDbMissing(); } } });
    const ctx = { req: new Request("http://test/api/expense/mapping-catalog"), params: {}, principal: principal(3, { isFinance: true }) };
    await expect(finance.mappingCatalog(ctx)).rejects.toMatchObject({ status: 503, message: "The catalog database does not exist; the infra operator checks its settings" });
  });

  it("matching and gift accounts pass a missing catalog database up, never \"not connected\"", async () => {
    bindPorts({ catalog: { ...catalogResolving({}), listCategories: async () => { throw catalogDbMissing(); } } });
    const line = { id: 1, partNumber: "P1", manufacturer: null, description: "drill", nonInventory: false };
    await expect(lookupCatalogInfo([line], "Acme")).rejects.toMatchObject({ code: "P1003" });
    await expect(resolveDonatedPartAccounts(ORG, [{ lineId: 7, gtin13: "0000000000017", isCapital: false }])).rejects.toMatchObject({ code: "P1003" });
  });

  it("the inert outbound gateway sends nothing", async () => {
    const send = vi.fn(async () => "sent");
    await expect(inertOutbound("quickbooks.create", { Expense: { id: "e1" } }, send)).rejects.toThrow(/no outbound gateway/);
    expect(send).not.toHaveBeenCalled();
  });

  it("assertOrg accepts only the injected org", async () => {
    await expect(assertOrg(ORG)).resolves.toBeUndefined();
    await expect(assertOrg("org-other")).rejects.toThrow(/not this org/);
  });

  it.each([
    ["giftsAwaitingCapitalReview", () => giftsAwaitingCapitalReview("org-other")],
    ["donatedAssetLineIds", () => donatedAssetLineIds("org-other", { giftSource: "receipt", giftId: 1 })],
    ["qbPostingOnAt", () => qbPostingOnAt("org-other")],
    ["resolveDonatedPartAccounts", () => resolveDonatedPartAccounts("org-other", [])],
  ])("%s refuses another org as a wiring bug, before any read", async (_name, call) => {
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not this org/);
    expect(isServiceError(err)).toBe(false);
  });
});

describe("X12 reimbursementStatus", () => {
  it("answers nothing for no receipts, before any read", async () => {
    expect(await reimbursementStatus.forReceipts([])).toEqual(new Map());
  });

  it("parses its input", async () => {
    await expect(reimbursementStatus.forReceipts(["r1"])).rejects.toThrow();
    await expect(reimbursementStatus.forReceipts([{ receiptId: 1 }])).rejects.toThrow();
  });
});

describe("flags", () => {
  it("keeps three finance review kinds and retires the rest", () => {
    expect(FLAG_KINDS).toEqual(["QB_DUPLICATE_TO_VOID", "QB_DRIFT", "QB_POST_HELD"]);
    expect(Object.values(FLAG_AUDIENCE)).toEqual(["FINANCE", "FINANCE", "FINANCE"]);
    expect(isFlagKind("QB_DRIFT")).toBe(true);
    for (const kind of RETIRED_FLAG_KINDS) expect(isFlagKind(kind)).toBe(false);
  });
});

describe("tax waits on finance", () => {
  const review = (over: Partial<StoredReceiptReview> = {}): StoredReceiptReview => ({
    taxReviewRequired: true,
    reasons: ["tax"],
    approvedTaxCents: 125,
    ...over,
  });

  it("not when receipt finance review approved that tax", () => {
    expect(taxNeedsFinance(125, review())).toBe(false);
  });

  it("never when the receipt org's settings do not hold tax for review", () => {
    expect(taxNeedsFinance(125, review({ taxReviewRequired: false, reasons: [], approvedTaxCents: null }))).toBe(false);
  });

  it("when the tax differs from the amount finance approved", () => {
    expect(taxNeedsFinance(150, review())).toBe(true);
    expect(taxNeedsFinance(125, review({ approvedTaxCents: null }))).toBe(true);
  });

  it("when review applies and no approval covers tax", () => {
    expect(taxNeedsFinance(125, review({ reasons: [], approvedTaxCents: null }))).toBe(true);
    expect(taxNeedsFinance(125, review({ reasons: ["old_date"] }))).toBe(true);
  });

  it("when the receipt did not say whether review applies, unless finance approved that tax", () => {
    expect(taxNeedsFinance(125, null)).toBe(true);
    expect(taxNeedsFinance(125, review({ taxReviewRequired: null }))).toBe(false);
  });

  it("never on a receipt with no tax", () => {
    expect(taxNeedsFinance(0, review({ reasons: [], approvedTaxCents: null }))).toBe(false);
  });
});
