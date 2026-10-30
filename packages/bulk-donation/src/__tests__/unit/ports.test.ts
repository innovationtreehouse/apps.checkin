import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ZodError } from "zod";
import type { CompletedReceipt } from "@checkin/receipt-types";
import { bulkDonationRuntime, configureBulkDonation, getInventoryApply, getOwnerDirectory, NotWiredError } from "../../runtime";
import { getCatalogItem, ingestInKind, recordInKindDonor, recordInKindWithoutReceipt, searchCatalog, withdrawInKind } from "../../inKind";
import { MAX_IN_KIND_LINES, MAX_IN_KIND_LINE_QUANTITY, MAX_IN_KIND_LINE_VALUE_CENTS, type ManualInKindInput } from "../../services/manualInKindService";
import { inventorySourceKey } from "../../contract";
import { inKindService } from "../../services/inKindService";

vi.mock("../../services/inKindService", () => ({
  inKindService: { recordMoney: vi.fn(), recordDonor: vi.fn(), withdraw: vi.fn(), settle: vi.fn() },
}));

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
    org: async () => ({ id: ORG, name: "Test Org" }),
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  configure();
});
afterEach(() => {
  bulkDonationRuntime.reset();
});

describe("X9 ingestInKind (callee)", () => {
  it("rejects a receipt from another org at parse time", async () => {
    await expect(ingestInKind(receipt("other-org"))).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects a purchase receipt", async () => {
    await expect(ingestInKind({ ...receipt(ORG), isInKind: false })).rejects.toBeInstanceOf(ZodError);
    expect(inKindService.recordMoney).not.toHaveBeenCalled();
  });

  it("records this org's money side", async () => {
    await ingestInKind(receipt(ORG));
    expect(inKindService.recordMoney).toHaveBeenCalledWith(ORG, RECEIPT_ID, {
      receiptTotalCents: 1000,
      receiptDate: "2026-09-01",
      uploadedByUserId: 7,
      lines: [{ receiptLineItemId: 1, lineNumber: 1, description: "Drill", gtin13: null, quantity: 1, valueCents: 1000 }],
    });
  });

  it("reads the org at call time, not at import", async () => {
    configure({ org: async () => ({ id: "other-org", name: "Other" }) });
    await ingestInKind(receipt("other-org"));
    expect(inKindService.recordMoney).toHaveBeenCalledWith("other-org", RECEIPT_ID, expect.anything());
  });
});

describe("X13 recordInKindDonor / withdrawInKind (callees)", () => {
  const DONOR = { firstName: "Jane", lastName: "Doe", companyName: null };

  it("rejects another org at parse time", async () => {
    await expect(recordInKindDonor("other-org", RECEIPT_ID, DONOR, 0)).rejects.toBeInstanceOf(ZodError);
    await expect(withdrawInKind("other-org", RECEIPT_ID, 0)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects a blank donor name", async () => {
    await expect(recordInKindDonor(ORG, RECEIPT_ID, { ...DONOR, firstName: "" }, 0)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects an empty receipt id", async () => {
    await expect(withdrawInKind(ORG, "", 0)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects a negative or fractional sync seq", async () => {
    await expect(recordInKindDonor(ORG, RECEIPT_ID, DONOR, -1)).rejects.toBeInstanceOf(ZodError);
    await expect(withdrawInKind(ORG, RECEIPT_ID, 1.5)).rejects.toBeInstanceOf(ZodError);
  });

  it("records a valid call", async () => {
    await recordInKindDonor(ORG, RECEIPT_ID, DONOR, 2);
    await withdrawInKind(ORG, RECEIPT_ID, 3);
    expect(inKindService.recordDonor).toHaveBeenCalledWith(ORG, RECEIPT_ID, DONOR, 2);
    expect(inKindService.withdraw).toHaveBeenCalledWith(ORG, RECEIPT_ID, 3);
  });
});

describe("caller ports", () => {
  it("unbound ports are inert: empty reads, throwing writes", async () => {
    expect(await searchCatalog("drill")).toEqual([]);
    expect(await getCatalogItem("0000000000000")).toBeNull();
    expect(await getOwnerDirectory().list()).toEqual([]);
    await expect(getInventoryApply().apply({ receiptId: inventorySourceKey(1), orgId: ORG, retailer: null, lineItems: [] })).rejects.toBeInstanceOf(NotWiredError);
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
    bulkDonationRuntime.reset();
    await expect(ingestInKind(receipt(ORG))).rejects.toThrow(/runtime not configured/);
  });
});

describe("no-receipt in-kind entry: input bounds (rejected before any catalog or DB call)", () => {
  const line: ManualInKindInput["lines"][number] = { gtin13: "0011111111116", quantity: 1, suggestedValueCents: 100 };
  const input: ManualInKindInput = { donor: { firstName: "Jane", lastName: "Doe", companyName: null }, donationDate: "2026-10-01", lines: [line] };
  const rejects = (over: Partial<ManualInKindInput>, lineOver: Partial<typeof line> = {}) =>
    expect(recordInKindWithoutReceipt({ ...input, ...over, lines: [{ ...line, ...lineOver }] })).rejects.toMatchObject({ status: 400 });

  it("requires a donor name", async () => {
    await rejects({ donor: { firstName: "", lastName: "Doe", companyName: null } });
  });

  it("requires a calendar date", async () => {
    await rejects({ donationDate: "Oct 1" });
  });

  it("bounds quantity to a positive integer under the cap", async () => {
    await rejects({}, { quantity: 0 });
    await rejects({}, { quantity: 1.5 });
    await rejects({}, { quantity: MAX_IN_KIND_LINE_QUANTITY + 1 });
  });

  it("bounds the suggested value to non-negative integer cents under the cap", async () => {
    await rejects({}, { suggestedValueCents: -1 });
    await rejects({}, { suggestedValueCents: 9.99 });
    await rejects({}, { suggestedValueCents: MAX_IN_KIND_LINE_VALUE_CENTS + 1 });
  });

  it("caps the line count and the suggested total", async () => {
    const many = Array.from({ length: MAX_IN_KIND_LINES + 1 }, () => line);
    await expect(recordInKindWithoutReceipt({ ...input, lines: many })).rejects.toMatchObject({ status: 400 });
    const big = { ...line, suggestedValueCents: MAX_IN_KIND_LINE_VALUE_CENTS };
    await expect(recordInKindWithoutReceipt({ ...input, lines: [big, big] })).rejects.toMatchObject({ status: 400 });
  });

  it("bounds a line's description", async () => {
    await rejects({}, { description: "x".repeat(501) });
  });

  it("requires at least one line", async () => {
    await expect(recordInKindWithoutReceipt({ ...input, lines: [] })).rejects.toMatchObject({ status: 400 });
  });
});
