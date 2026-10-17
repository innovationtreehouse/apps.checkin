import Anthropic from "@anthropic-ai/sdk";
import { OcrDataSchema, type OcrData, type OcrProvider, type OcrResult } from "../contract";

const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Parse a verbatim money string ("$69.89", "$1,553.00"). Models copy strings reliably but
 *  sometimes emit the JSON number with the decimal dropped, so the string wins. */
export function parseMoney(s: unknown): number | null {
  if (s == null) return null;
  const m = String(s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const lineItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", description: "Item name or description" },
    partNumber: { type: "string", description: "SKU or part number if shown" },
    manufacturer: { type: "string", description: "Manufacturer name if shown" },
    quantity: { type: "number", description: "Quantity, default 1" },
    unitPrice: { type: "number", description: "Price per unit" },
    isDelayed: { type: "boolean", description: "True if item is marked backordered or delayed" },
  },
  required: ["description", "quantity", "unitPrice", "isDelayed"],
};

export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    retailer: { type: "string", description: "Store or vendor name" },
    receiptNumber: { type: "string", description: "Receipt or invoice number printed on the receipt, if present" },
    orderNumber: { type: "string", description: "Order number or confirmation number, if present" },
    receiptDate: { type: "string", description: "Date in YYYY-MM-DD format" },
    currency: { type: "string", description: "3-letter currency code, default USD" },
    shipping: { type: "number", description: "Shipping cost, 0 if not present" },
    tax: { type: "number", description: "Tax amount, 0 if not present" },
    discount: { type: "number", description: "Total discount or coupon amount, 0 if not present" },
    receiptTotalText: {
      type: "string",
      description: 'The receipt/order total copied VERBATIM as printed, e.g. "$69.89" — digits and decimal exactly as shown',
    },
    receiptTotal: { type: "number", description: "Total amount paid" },
    lineItems: { type: "array", description: "All line items on the receipt", items: lineItemSchema },
  },
  required: ["retailer", "receiptDate", "currency", "shipping", "tax", "discount", "receiptTotal", "lineItems"],
};

const INSTRUCTION =
  "Extract all data from this receipt. Use today's date to resolve any ambiguous years. If a field is not present on the receipt, use the default value described in the schema.";

/** Map a raw model object to OcrData, keeping only the receipt's own fields. */
export function mapRawToOcrData(raw: Record<string, unknown>): OcrData {
  const totalFromText = parseMoney(raw.receiptTotalText);
  const lines = Array.isArray(raw.lineItems) ? raw.lineItems : [];
  return OcrDataSchema.parse({
    retailer: String(raw.retailer ?? ""),
    receiptNumber: raw.receiptNumber ? String(raw.receiptNumber) : undefined,
    orderNumber: raw.orderNumber ? String(raw.orderNumber) : undefined,
    receiptDate: String(raw.receiptDate ?? ""),
    currency: String(raw.currency ?? "USD"),
    shipping: Number(raw.shipping ?? 0),
    tax: Number(raw.tax ?? 0),
    discount: Number(raw.discount ?? 0),
    receiptTotalText: raw.receiptTotalText ? String(raw.receiptTotalText) : undefined,
    receiptTotal: totalFromText ?? Number(raw.receiptTotal ?? 0),
    lineItems: lines.map((item: unknown) => {
      const li = (item ?? {}) as Record<string, unknown>;
      return {
        description: String(li.description ?? ""),
        partNumber: li.partNumber ? String(li.partNumber) : undefined,
        manufacturer: li.manufacturer ? String(li.manufacturer) : undefined,
        quantity: Number(li.quantity ?? 1),
        unitPrice: Number(li.unitPrice ?? 0),
        isDelayed: Boolean(li.isDelayed ?? false),
      };
    }),
  });
}

type ContentBlock = Anthropic.Beta.Messages.BetaContentBlockParam;
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** The file as bytes in the request; the API never fetches a URL. */
export function buildContent(file: Buffer, mimeType: string): ContentBlock[] {
  if (mimeType === "text/plain") {
    return [{ type: "text", text: `Receipt contents:\n\n${file.toString("utf-8")}` }];
  }
  const data = file.toString("base64");
  if (mimeType === "application/pdf") {
    return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }];
  }
  if (IMAGE_TYPES.includes(mimeType)) {
    return [{ type: "image", source: { type: "base64", media_type: mimeType as ImageMediaType, data } }];
  }
  throw new Error(`Unsupported MIME type: ${mimeType}`);
}

function complete(data: OcrData): boolean {
  return !!data.retailer && !!data.receiptDate && data.lineItems.length > 0;
}

/** The real provider. Without a key it fails closed into ocr_failed; manual entry keeps working. */
export function createAnthropicOcr(apiKey: string | undefined): OcrProvider {
  if (!apiKey) return { extract: async () => ({ success: false, error: "OCR is not configured" }) };
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });

  return {
    async extract(file, mimeType): Promise<OcrResult> {
      try {
        const response = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          output_config: { effort: "medium", format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
          messages: [{ role: "user", content: [...buildContent(file, mimeType), { type: "text", text: INSTRUCTION }] }],
        });
        if (response.stop_reason === "refusal") return { success: false, error: "OCR refused the document" };

        const text = response.content.find((b) => b.type === "text");
        if (!text || text.type !== "text") return { success: false, error: "OCR returned no structured receipt data" };
        let raw: unknown;
        try {
          raw = JSON.parse(text.text);
        } catch {
          return { success: false, error: "OCR returned unparseable receipt data" };
        }
        if (typeof raw !== "object" || raw === null) return { success: false, error: "OCR returned unparseable receipt data" };

        const parsed = OcrDataSchema.safeParse(mapRawToOcrDataSafe(raw as Record<string, unknown>));
        if (!parsed.success || !complete(parsed.data)) {
          return { success: false, error: "OCR returned incomplete receipt data (missing retailer, date, or line items)" };
        }
        return { success: true, data: parsed.data };
      } catch (err) {
        return { success: false, error: `OCR API error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function mapRawToOcrDataSafe(raw: Record<string, unknown>): OcrData | null {
  try {
    return mapRawToOcrData(raw);
  } catch {
    return null;
  }
}

/** Deterministic local adapter (CHECKIN_ENV=local, flow tests, dev seed). */
export const fixtureOcr: OcrProvider = {
  extract: async () => ({
    success: true,
    data: {
      retailer: "Fixture Hardware",
      receiptDate: new Date().toISOString().slice(0, 10),
      currency: "USD",
      shipping: 0,
      tax: 0,
      discount: 0,
      receiptTotal: 12.5,
      lineItems: [{ description: "Fixture widget", quantity: 1, unitPrice: 12.5, isDelayed: false }],
    },
  }),
};
