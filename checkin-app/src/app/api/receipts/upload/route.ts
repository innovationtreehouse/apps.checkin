// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { MAX_FILE_BYTES, receiptService } from "@inventory/receipt";
import { badRequest, handler } from "@/security/handler";
import { readUploadForm, receiptRoute, sessionId, spendOcrQuota } from "@/lib/receipt/route";

/**
 * Multipart: `file` is the receipt, `data` an optional JSON string of the upload input. With
 * `data.details` the upload is manual; without, OCR reads the file in this request.
 */
export const POST = handler(
  "POST /api/receipts/upload",
  receiptRoute(async (ctx) => {
    const form = await readUploadForm(ctx.req, MAX_FILE_BYTES);
    const file = form.get("file");
    if (!(file instanceof File)) throw badRequest("A receipt file is required");
    const data = form.get("data");
    let input: unknown = {};
    if (typeof data === "string" && data.trim()) {
      try {
        input = JSON.parse(data);
      } catch {
        throw badRequest("data must be JSON");
      }
    }
    const manual = typeof input === "object" && input !== null && "details" in input;
    if (!manual) spendOcrQuota(sessionId(ctx));
    return { ReceiptView: await receiptService.upload(Buffer.from(await file.arrayBuffer()), file.type, input) };
  }),
);
