import { describe, it, expect } from "vitest";
import { CompletedReceiptSchema } from "@checkin/receipt-types";
import { FIXTURE_MANIFEST, loadRaw } from "./index";

const raw = (id: string) => loadRaw(FIXTURE_MANIFEST.find((e) => e.id === id)!) as Record<string, unknown>;
const approved = raw("S1-completed-receipt/finance-approved-tax");
const review = approved.financeReview as Record<string, unknown>;
const withReview = (over: Record<string, unknown>) => ({ ...approved, financeReview: { ...review, ...over } });

describe("CompletedReceipt.financeReview", () => {
  it("is optional: a payload from before the field still parses, without one", () => {
    const parsed = CompletedReceiptSchema.parse(raw("S1-completed-receipt/with-tax-shipping-discount"));
    expect(parsed.financeReview).toBeUndefined();
  });

  it("carries finance's approval, reasons, approver, note, approved tax and time", () => {
    expect(CompletedReceiptSchema.parse(approved).financeReview).toEqual(review);
  });

  it("carries whether the receipt org held its tax for review, absent from older senders", () => {
    expect(CompletedReceiptSchema.parse(approved).taxReviewRequired).toBe(true);
    expect(CompletedReceiptSchema.parse(raw("S1-completed-receipt/with-tax-shipping-discount")).taxReviewRequired).toBeUndefined();
  });

  it("parses an approval with no note", () => {
    const { note: _note, ...noNote } = review;
    expect(CompletedReceiptSchema.parse({ ...approved, financeReview: noNote }).financeReview).toEqual(noNote);
  });

  it.each([
    ["a rejection", withReview({ outcome: "rejected" })],
    ["an unknown reason", withReview({ reasons: ["vibes"] })],
    ["a non-positive approver", withReview({ decidedByPersonId: 0 })],
    ["a time that is not ISO", withReview({ decidedAt: "yesterday" })],
    ["a negative approved tax", withReview({ taxCents: -1 })],
  ])("refuses %s", (_label, input) => {
    expect(CompletedReceiptSchema.safeParse(input).success).toBe(false);
  });
});
