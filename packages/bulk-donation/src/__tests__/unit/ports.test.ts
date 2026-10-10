import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ZodError } from "zod";
import type { CompletedReceipt } from "@inventory/receipt-types";
import { configureBulkDonation, getInventoryApply, getOwnerDirectory, getQbWriter, NotWiredError } from "../../runtime";
import { getCatalogItem, ingestInKind, recordInKindDonor, searchCatalog, withdrawInKind } from "../../inKind";
import { inventorySourceKey } from "../../contract";
import { deriveTakeoverLine } from "../../lib/qb-match";

const ORG = "00000000-0000-0000-0000-000000000001";
const RECEIPT_ID = "5f0c6a3e-1d2b-4c8e-9a7f-2b3c4d5e6f70";

function receipt(orgId: string): CompletedReceipt {
  return {
    receiptId: RECEIPT_ID,
    orgId,
    submitterId: 7,
    vendorName: "Hardware Co",
    receiptNumber: null,
    orderNumber: null,
    currency: "USD",
    taxCents: 0,
    shippingCents: 0,
    discountCents: 0,
    receiptTotalCents: 1000,
    receiptDate: "2026-09-01",
    needsReimbursement: false,
    reimbursementFor: null,
    submittedAt: "2026-09-01T12:00:00.000Z",
    backfill: false,
    isInKind: true,
    lineItems: [
      { receiptLineItemId: 1, lineNumber: 1, description: "Drill", partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: 1000, totalPriceCents: 1000, isDelayed: false },
    ],
  };
}

const configure = (extra: Partial<Parameters<typeof configureBulkDonation>[0]> = {}) =>
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "finance" }) },
    org: () => ({ id: ORG, name: "Test Org" }),
    ...extra,
  });

beforeEach(() => configure());
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__bulkDonationRuntime;
});

describe("X9 ingestInKind (callee)", () => {
  it("rejects a receipt from another org at parse time", async () => {
    await expect(ingestInKind(receipt("other-org"))).rejects.toBeInstanceOf(ZodError);
  });

  it("accepts this org's receipt, then throws not-wired so the caller retries", async () => {
    await expect(ingestInKind(receipt(ORG))).rejects.toBeInstanceOf(NotWiredError);
  });

  it("reads the org at call time, not at import", async () => {
    configure({ org: () => ({ id: "other-org", name: "Other" }) });
    await expect(ingestInKind(receipt("other-org"))).rejects.toBeInstanceOf(NotWiredError);
  });
});

describe("X13 recordInKindDonor / withdrawInKind (callees)", () => {
  const DONOR = { firstName: "Jane", lastName: "Doe", companyName: null };

  it("rejects another org at parse time", async () => {
    await expect(recordInKindDonor("other-org", RECEIPT_ID, DONOR)).rejects.toBeInstanceOf(ZodError);
    await expect(withdrawInKind("other-org", RECEIPT_ID)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects a blank donor name", async () => {
    await expect(recordInKindDonor(ORG, RECEIPT_ID, { ...DONOR, firstName: "" })).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects an empty receipt id", async () => {
    await expect(withdrawInKind(ORG, "")).rejects.toBeInstanceOf(ZodError);
  });

  it("throws not-wired on a valid call", async () => {
    await expect(recordInKindDonor(ORG, RECEIPT_ID, DONOR)).rejects.toBeInstanceOf(NotWiredError);
    await expect(withdrawInKind(ORG, RECEIPT_ID)).rejects.toBeInstanceOf(NotWiredError);
  });
});

describe("caller ports", () => {
  it("unbound ports are inert: empty reads, throwing writes", async () => {
    expect(await searchCatalog("drill")).toEqual([]);
    expect(await getCatalogItem("0000000000000")).toBeNull();
    expect(await getOwnerDirectory().list()).toEqual([]);
    await expect(getInventoryApply().apply({ receiptId: inventorySourceKey(1), orgId: ORG, retailer: null, lineItems: [] })).rejects.toBeInstanceOf(NotWiredError);
    await expect(
      getQbWriter().post({ stream: "benevity", retryKey: "k", netCents: 1, depositDate: "2026-09-01", takeoverLine: null, claimedQbTxnIds: [], excludedQbTxnIds: [] }),
    ).rejects.toBeInstanceOf(NotWiredError);
  });

  it("X10 parses what the bound catalog returns", async () => {
    // A malformed response, as an adapter over an untyped transport could return.
    configure({ catalog: { search: async () => JSON.parse('[{"gtin13":"123"}]'), getItem: async () => null } });
    await expect(searchCatalog("x")).rejects.toBeInstanceOf(ZodError);
  });

  it("X11 keys inventory loads per source", () => {
    expect(inventorySourceKey(42)).toBe("donation:42");
  });

  it("an unconfigured runtime fails loudly", async () => {
    delete (globalThis as Record<string, unknown>).__bulkDonationRuntime;
    await expect(ingestInKind(receipt(ORG))).rejects.toThrow(/configureBulkDonation/);
  });
});

describe("deriveTakeoverLine", () => {
  it("is the newest MATCHED date; CREATED and others never move it", () => {
    expect(
      deriveTakeoverLine([
        { date: "2026-03-01", qbMatchState: "MATCHED" },
        { date: "2026-05-01", qbMatchState: "CREATED" },
        { date: "2026-04-01", qbMatchState: "MATCHED" },
        { date: "2026-06-01", qbMatchState: "AMBIGUOUS" },
      ]),
    ).toBe("2026-04-01");
  });

  it("has no line without a MATCHED record (fail closed)", () => {
    expect(deriveTakeoverLine([{ date: "2026-05-01", qbMatchState: "CREATED" }])).toBeNull();
    expect(deriveTakeoverLine([])).toBeNull();
  });
});
