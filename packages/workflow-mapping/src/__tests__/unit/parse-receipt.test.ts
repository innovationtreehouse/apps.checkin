import { describe, it, expect } from "vitest";
import { formatCents } from "@checkin/money";
import { parseStoredReceipt } from "../../lib/parse-receipt";
import { buildReceiptPayload } from "../helpers/setup";

describe("parseStoredReceipt", () => {
  // ── Positive ─────────────────────────────────────────────────────────────
  it("returns ok:true for a valid CompletedReceipt JSON string", () => {
    const json = JSON.stringify(buildReceiptPayload());
    const result = parseStoredReceipt(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.receiptId).toBeDefined();
      expect(result.receipt.lineItems).toHaveLength(1);
    }
  });

  it("accepts a multi-line receipt", () => {
    const json = JSON.stringify(buildReceiptPayload({ lineCount: 3 }));
    const result = parseStoredReceipt(json);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.lineItems).toHaveLength(3);
  });

  // The receiving list formats each row it parses, and an unparsed row as a blank total.
  it("keeps the receiving list rendering when a stored row's currency is not a code", () => {
    const result = parseStoredReceipt(JSON.stringify({ ...buildReceiptPayload(), currency: "US$" }));
    const row = result.ok ? result.receipt : null;
    expect(formatCents(row?.receiptTotalCents ?? null, row?.currency ?? "USD")).toBe("—");
  });

  it("shows a stored blank currency as a normal USD receipt", () => {
    const result = parseStoredReceipt(JSON.stringify({ ...buildReceiptPayload(), currency: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.currency).toBe("USD");
      expect(formatCents(result.receipt.receiptTotalCents, result.receipt.currency)).toMatch(/^\$/);
    }
  });

  // ── Negative: malformed JSON ─────────────────────────────────────────────
  it("returns ok:false for a non-JSON string", () => {
    const result = parseStoredReceipt("{ not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not valid JSON/i);
  });

  it("returns ok:false for an empty string", () => {
    const result = parseStoredReceipt("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not valid JSON/i);
  });

  // ── Negative: wrong schema ────────────────────────────────────────────────
  it("returns ok:false for valid JSON that fails CompletedReceiptSchema", () => {
    const result = parseStoredReceipt('{"completely": "wrong"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/failed validation/i);
  });

  it("returns ok:false for JSON missing required receipt fields", () => {
    const partial = JSON.stringify({ receiptId: "x" });
    const result = parseStoredReceipt(partial);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for a JSON array (wrong root type)", () => {
    const result = parseStoredReceipt("[]");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for a JSON null", () => {
    const result = parseStoredReceipt("null");
    expect(result.ok).toBe(false);
  });
});
