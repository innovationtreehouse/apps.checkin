// The only way a receipt's bytes leave (plan rule 7). fileHandler fixes the delivery headers
// per type; the library audits every read. The endpoint string MUST match its
// src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { FILE_CONTENT_TYPES, type FileContentType } from "@/security/core";
import { fileHandler } from "@/security/fileHandler";
import { accessOf, mapServiceErrors } from "@/lib/receipt/route";

function isFileContentType(type: string): type is FileContentType {
  return (FILE_CONTENT_TYPES as readonly string[]).includes(type);
}

export const GET = fileHandler<{ id: string }>("GET /api/receipts/[id]/file", async ({ params, role }) => {
  const file = await mapServiceErrors(() => receiptService.getFile(params.id, accessOf(role)));
  // Upload's magic-byte check admits only allowlisted types; anything else is a stored-data bug.
  if (!isFileContentType(file.mimeType)) throw new Error(`receipt ${params.id} has unservable type ${file.mimeType}`);
  return {
    row: { fileBlob: file.fileBlob, uploadedByUserId: file.uploadedByUserId },
    contentType: file.mimeType,
    filename: file.mimeType === "text/plain" ? `receipt-${params.id}.txt` : undefined,
  };
});
