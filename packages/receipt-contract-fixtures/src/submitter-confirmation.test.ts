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

  it("carries whose confirmation it is, the person reimbursed, and when", () => {
    expect(CompletedReceiptSchema.parse(withConfirmation({})).submitterConfirmation).toEqual(confirmation);
  });

  it("names the Board member who confirmed on the reimbursee's behalf, and why", () => {
    const onBehalf = { onBehalfByPersonId: 5, onBehalfReason: "no email address" };
    expect(CompletedReceiptSchema.parse(withConfirmation(onBehalf)).submitterConfirmation).toEqual({ ...confirmation, ...onBehalf });
  });

  it.each([
    ["a non-positive Board member", withConfirmation({ onBehalfByPersonId: 0 })],
    ["a non-positive confirmer", withConfirmation({ confirmedByPersonId: 0 })],
    ["a time that is not ISO", withConfirmation({ confirmedAt: "this morning" })],
  ])("refuses %s", (_label, input) => {
    expect(CompletedReceiptSchema.safeParse(input).success).toBe(false);
  });
});
