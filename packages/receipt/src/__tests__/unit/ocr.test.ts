import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.hoisted(() => vi.fn());
const ctorArgs = vi.hoisted(() => [] as unknown[]);

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create: createMock } };
    constructor(opts: unknown) {
      ctorArgs.push(opts);
    }
  },
}));

import { createAnthropicOcr, fixtureOcr, mapRawToOcrData, parseMoney } from "../../lib/ocr";

const VALID_INPUT = {
  retailer: "Acme Hardware",
  receiptNumber: "R-100",
  orderNumber: "O-200",
  receiptDate: "2026-05-01",
  currency: "USD",
  shipping: 1,
  tax: 2,
  discount: 0,
  receiptTotal: 23,
  lineItems: [
    { description: "Bolt", partNumber: "B-1", manufacturer: "Acme", quantity: 2, unitPrice: 10, isDelayed: false },
  ],
};

function jsonResponse(input: unknown, stop_reason = "end_turn") {
  return { stop_reason, content: [{ type: "text", text: JSON.stringify(input) }] };
}

const TXT = Buffer.from("Receipt: Bolt x2 $20");
const ocr = createAnthropicOcr("test-key");

beforeEach(() => {
  createMock.mockReset();
  ctorArgs.length = 0;
});

describe("createAnthropicOcr — configuration", () => {
  it("fails closed without a key and never calls the API", async () => {
    const res = await createAnthropicOcr(undefined).extract(TXT, "text/plain");
    expect(res).toEqual({ success: false, error: "OCR is not configured" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("builds the client with a 120 s timeout and two SDK retries", async () => {
    createMock.mockResolvedValue(jsonResponse(VALID_INPUT));
    await createAnthropicOcr("k").extract(TXT, "text/plain");
    expect(ctorArgs[0]).toMatchObject({ apiKey: "k", timeout: 120_000, maxRetries: 2 });
  });
});

describe("createAnthropicOcr — call shape", () => {
  it("asks Opus 5.5 for structured output at explicit medium effort, with default fallbacks", async () => {
    createMock.mockResolvedValue(jsonResponse(VALID_INPUT));
    await ocr.extract(TXT, "text/plain");
    const arg = createMock.mock.calls[0][0];
    expect(arg.model).toBe("claude-opus-5-5");
    expect(arg.output_config.effort).toBe("medium");
    expect(arg.output_config.format.type).toBe("json_schema");
    expect(arg.fallbacks).toBe("default");
    expect(arg.betas).toContain("server-side-fallback-2026-07-01");
    expect(arg.tool_choice).toBeUndefined();
    expect(arg.tools).toBeUndefined();
  });

  it("sends a PDF as a base64 document block, never a URL", async () => {
    createMock.mockResolvedValue(jsonResponse(VALID_INPUT));
    await ocr.extract(Buffer.from("%PDF-1.4 fake"), "application/pdf");
    const block = createMock.mock.calls[0][0].messages[0].content[0];
    expect(block).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
  });

  it("sends an image as a base64 image block", async () => {
    createMock.mockResolvedValue(jsonResponse(VALID_INPUT));
    await ocr.extract(Buffer.from([0x89, 0x50]), "image/webp");
    const block = createMock.mock.calls[0][0].messages[0].content[0];
    expect(block).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/webp" } });
  });
});

describe("createAnthropicOcr — results", () => {
  it("maps structured data", async () => {
    createMock.mockResolvedValue(jsonResponse(VALID_INPUT));
    const res = await ocr.extract(TXT, "text/plain");
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.retailer).toBe("Acme Hardware");
    expect(res.data.lineItems[0]).toMatchObject({ description: "Bolt", quantity: 2, unitPrice: 10 });
  });

  it("prefers the verbatim total over a dropped-decimal number", async () => {
    createMock.mockResolvedValue(jsonResponse({ ...VALID_INPUT, receiptTotal: 6989, receiptTotalText: "$69.89" }));
    const res = await ocr.extract(TXT, "text/plain");
    expect(res.success && res.data.receiptTotal).toBe(69.89);
  });

  it("drops fields OCR may not set (reimbursement, reimbursee, vendor)", async () => {
    createMock.mockResolvedValue(
      jsonResponse({ ...VALID_INPUT, needsReimbursement: true, reimbursementFor: "Mallory", qbVendor: "X" }),
    );
    const res = await ocr.extract(TXT, "text/plain");
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(Object.keys(res.data)).not.toContain("needsReimbursement");
    expect(Object.keys(res.data)).not.toContain("reimbursementFor");
    expect(Object.keys(res.data)).not.toContain("qbVendor");
  });

  it("treats a final refusal as an OCR failure", async () => {
    createMock.mockResolvedValue({ stop_reason: "refusal", content: [] });
    const res = await ocr.extract(TXT, "text/plain");
    expect(res).toEqual({ success: false, error: "OCR refused the document" });
  });

  it("rejects unparseable output", async () => {
    createMock.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] });
    const res = await ocr.extract(TXT, "text/plain");
    expect(res.success).toBe(false);
  });

  it("rejects incomplete data (missing retailer or no lines)", async () => {
    createMock.mockResolvedValue(jsonResponse({ ...VALID_INPUT, retailer: "" }));
    expect((await ocr.extract(TXT, "text/plain")).success).toBe(false);
    createMock.mockResolvedValue(jsonResponse({ ...VALID_INPUT, lineItems: [] }));
    expect((await ocr.extract(TXT, "text/plain")).success).toBe(false);
  });

  it("wraps SDK errors instead of throwing", async () => {
    createMock.mockRejectedValue(new Error("rate limited"));
    expect(await ocr.extract(TXT, "text/plain")).toEqual({ success: false, error: "OCR API error: rate limited" });
  });
});

describe("pure helpers", () => {
  it("parseMoney reads printed totals", () => {
    expect(parseMoney("$1,553.00")).toBe(1553);
    expect(parseMoney(null)).toBeNull();
  });

  it("mapRawToOcrData defaults omitted fields", () => {
    const d = mapRawToOcrData({ retailer: "A", receiptDate: "2026-05-01", lineItems: [{ description: "x" }] });
    expect(d).toMatchObject({ currency: "USD", shipping: 0, tax: 0, discount: 0 });
    expect(d.lineItems[0]).toMatchObject({ quantity: 1, unitPrice: 0, isDelayed: false });
  });

  it("fixtureOcr answers deterministically without a network", async () => {
    const res = await fixtureOcr.extract(TXT, "text/plain");
    expect(res.success).toBe(true);
  });
});
