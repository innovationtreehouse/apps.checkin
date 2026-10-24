import { describe, it, expect } from "vitest";
import { CompletedReceiptSchema } from "@checkin/receipt-types";
import { FIXTURE_MANIFEST, loadRaw } from "./index";

const raw = (id: string) => loadRaw(FIXTURE_MANIFEST.find((e) => e.id === id)!) as Record<string, unknown>;
const reimbursement = raw("S1-completed-receipt/reimbursement-flagged");
const confirmation = { confirmedByPersonId: 7, confirmedAt: "2026-06-01T11:00:00.000Z" };
const withConfirmation = (over: Record<string, unknown>) => ({ ...reimbursement, submitterConfirmation: { ...confirmation, ...over } });

describe("CompletedReceipt.submitterConfirmation", () => {
  it("is optional: a payload from before the field still parses, without one", () => {
    expect(CompletedReceiptSchema.parse(reimbursement).submitterConfirmation).toBeUndefined();
  });

  it("carries who confirmed the receipt as read, and when", () => {
    expect(CompletedReceiptSchema.parse(withConfirmation({})).submitterConfirmation).toEqual(confirmation);
  });

  it.each([
    ["a non-positive confirmer", withConfirmation({ confirmedByPersonId: 0 })],
    ["a time that is not ISO", withConfirmation({ confirmedAt: "this morning" })],
  ])("refuses %s", (_label, input) => {
    expect(CompletedReceiptSchema.safeParse(input).success).toBe(false);
  });
});
