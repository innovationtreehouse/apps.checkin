// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { MAX_FILE_BYTES, receiptService } from "@inventory/receipt";
import { badRequest, handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/**
 * Multipart: `file` is the receipt, `data` an optional JSON string of the upload input. With
 * `data.details` the upload is manual; without, OCR reads the file in this request.
 */
export const POST = handler(
  "POST /api/receipts/upload",
  receiptRoute(async ({ req }) => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest("Expected multipart/form-data");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw badRequest("A receipt file is required");
    if (file.size > MAX_FILE_BYTES) throw badRequest("Receipt file exceeds 10 MB");
    const data = form.get("data");
    let input: unknown = {};
    if (typeof data === "string" && data.trim()) {
      try {
        input = JSON.parse(data);
      } catch {
        throw badRequest("data must be JSON");
      }
    }
    return { ReceiptView: await receiptService.upload(Buffer.from(await file.arrayBuffer()), file.type, input) };
  }),
);
