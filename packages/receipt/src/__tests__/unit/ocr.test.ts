import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.hoisted(() => vi.fn());
const ctorArgs = vi.hoisted(() => [] as unknown[]);

vi.mock("@anthropic-ai/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/sdk")>()),
  default: class {
    beta = { messages: { create: createMock } };
    constructor(opts: unknown) {
      ctorArgs.push(opts);
    }
  },
}));

import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { createAnthropicOcr, EXTRACT_SCHEMA, fixtureOcr, mapRawToOcrData, parseMoney } from "../../lib/ocr";

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
    expect(res).toEqual({ success: false, kind: "settings", error: "OCR is not configured" });
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
    expect(res).toEqual({ success: false, kind: "data", error: "the reader refused it" });
  });

  it("rejects unparseable output", async () => {
    createMock.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] });
    expect(await ocr.extract(TXT, "text/plain")).toEqual({ success: false, kind: "data", error: "the reader's answer could not be understood" });
  });

  it("rejects a reading with no lines", async () => {
    createMock.mockResolvedValue(jsonResponse({ ...VALID_INPUT, lineItems: [] }));
    expect(await ocr.extract(TXT, "text/plain")).toEqual({ success: false, kind: "data", error: "no line items were found" });
  });

  it("keeps a reading without its retailer, date or total, for the submitter to fill in", async () => {
    const noTotal: Record<string, unknown> = { ...VALID_INPUT };
    delete noTotal.receiptTotal;
    createMock.mockResolvedValue(jsonResponse({ ...noTotal, retailer: "", receiptDate: "" }));
    const res = await ocr.extract(TXT, "text/plain");
    expect(res.success && res.data).toMatchObject({ retailer: "", receiptDate: "", receiptTotal: null });
  });

  it("does not ask the model to invent a total", () => {
    expect(EXTRACT_SCHEMA.required).not.toContain("receiptTotal");
  });

});

describe("createAnthropicOcr — failure kinds, from the SDK's error classes", () => {
  const headers = new Headers({ "request-id": "req_123" });
  // The SDK's own status-to-class mapping, as a failed call raises it.
  const status = (code: number) => APIError.generate(code, { type: "error" }, "secret detail from the API", headers);

  it.each([
    ["a refused key", status(401), "connection"],
    ["a refused permission", status(403), "connection"],
    ["a rate limit after the SDK's retries", status(429), "system"],
    ["a server error", status(500), "system"],
    ["an overload", status(529), "system"],
    ["a connection error", new APIConnectionError({ message: "socket hang up" }), "system"],
    ["a timeout", new APIConnectionTimeoutError(), "system"],
    ["a bad request about the file", status(400), "data"],
    [
      "a used-up credit balance",
      APIError.generate(
        400,
        { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
        undefined,
        headers,
      ),
      "connection",
    ],
    ["a file too large", status(413), "data"],
    ["a model that is not found", status(404), "bug"],
    ["anything else", new TypeError("x is undefined"), "bug"],
  ])("sorts %s", async (_name, err, kind) => {
    createMock.mockRejectedValue(err);
    const res = await ocr.extract(TXT, "text/plain");
    expect(res).toMatchObject({ success: false, kind });
  });

  it("logs the request id, never the API's message, and keeps the message out of the result", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    createMock.mockRejectedValue(status(500));
    const res = await ocr.extract(TXT, "text/plain");
    expect(JSON.stringify(res)).not.toContain("secret detail");
    expect(JSON.stringify(logged.mock.calls)).toContain("req_123");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret detail");
    logged.mockRestore();
  });
});

describe("pure helpers", () => {
  it("parseMoney reads printed totals", () => {
    expect(parseMoney("$1,553.00")).toBe(1553);
    expect(parseMoney(null)).toBeNull();
  });

  it("mapRawToOcrData defaults omitted fields", () => {
    const d = mapRawToOcrData({ retailer: "A", receiptDate: "2026-05-01", lineItems: [{ description: "x" }] });
    expect(d).toMatchObject({ currency: "USD", shipping: 0, tax: 0, discount: 0, receiptTotal: null });
    expect(d.lineItems[0]).toMatchObject({ quantity: 1, unitPrice: 0, isDelayed: false });
  });

  it("fixtureOcr answers deterministically without a network", async () => {
    const res = await fixtureOcr.extract(TXT, "text/plain");
    expect(res.success).toBe(true);
  });
});
