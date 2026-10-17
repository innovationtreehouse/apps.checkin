// The only way a held mail item's bytes leave (plan rule 7). fileHandler fixes the delivery
// headers per type; the library audits every read. The endpoint string MUST match its
// src/security/registry/receipt.ts entry.
import { mailQueueService } from "@checkin/receipt";
import { FILE_CONTENT_TYPES, type FileContentType } from "@/security/core";
import { fileHandler } from "@/security/fileHandler";
import { mailItemId, mapServiceErrors } from "@/lib/receipt/route";

function isFileContentType(type: string): type is FileContentType {
  return (FILE_CONTENT_TYPES as readonly string[]).includes(type);
}

export const GET = fileHandler<{ id: string }>("GET /api/receipts/mail-items/[id]/file", async ({ params }) => {
  const file = await mapServiceErrors(() => mailQueueService.getFile(mailItemId(params.id)));
  // Intake's magic-byte check admits only allowlisted types; anything else is a stored-data bug.
  if (!isFileContentType(file.mimeType)) throw new Error(`mail item ${params.id} has unservable type ${file.mimeType}`);
  return {
    row: { id: file.id, fileBlob: file.fileBlob },
    contentType: file.mimeType,
    filename: file.mimeType === "text/plain" ? `mail-item-${params.id}.txt` : undefined,
  };
});
