/** Crossing guards and inert adapters — no database. */
import { describe, it, expect, vi } from "vitest";
import { callerId } from "../../lib/caller";
import { assertOrg, getExpenseRuntime } from "../../runtime";
import { inertOutbound, inertOwnerDirectory } from "../../contract";
import { reimbursementStatus } from "../../services/reimbursementStatus";
import { approveLine } from "../../services/approvalService";
import { FLAG_AUDIENCE, FLAG_KINDS, RETIRED_FLAG_KINDS, isFlagKind, taxNeedsFinance, type StoredReceiptReview } from "../../lib/flags";
import { ORG } from "../helpers/seed";

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
    expect(await rt.catalog.listCategories()).toEqual([]);
    expect(await rt.catalogEvents.eventsAfter(0)).toEqual([]);
    expect(await inertOwnerDirectory.list()).toEqual([]);
    expect(await rt.signoff.bucketApprovers(1)).toEqual({ orgLevel: false, approvers: [], owner: null });
    expect(await rt.quickbooks.reader.purchasesBetween("2026-01-01", "2026-01-31")).toEqual([]);
    await expect(rt.quickbooks.posting()).resolves.toBeNull();
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
