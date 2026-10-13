/** Benevity uploads: list, import, the stored-CSV download, and dropping an all-duplicate blob. */
import { db } from "../db";
import { CsvValidationError, parseBenevityCsv } from "../lib/csv-parser";
import { recordDonorDataRead } from "../repositories/audit";
import { uploadedFileService } from "../services/uploadedFileService";
import { donationError, getOrgId, mapServiceErrors } from "../runtime";
import type { DonationFileRouteHandler, DonationRouteHandler } from "../contract";
import { auditContext, donorReader, parseId } from "./_shared";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Room over the file cap for the multipart framing. */
const FORM_OVERHEAD_BYTES = 512 * 1024;
/** Browsers label a .csv as any of these; Excel on Windows says vnd.ms-excel, some send none. */
const CSV_MIME_TYPES = new Set(["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", ""]);

const tooLarge = () => donationError(413, "File is larger than 10 MB");

/**
 * Reads at most `cap` bytes: an over-cap Content-Length is refused before any read, otherwise
 * reading stops as soon as the total passes the cap. Duplicated from checkin's receipt glue
 * (`readCapped`, #1973) because a library does not import from the host or another library.
 */
async function readCapped(req: Request, cap: number): Promise<Uint8Array<ArrayBuffer>[]> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > cap) throw tooLarge();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  if (!req.body) return chunks;
  const reader = req.body.getReader();
  let total = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    total += r.value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(new Uint8Array(r.value));
  }
  return chunks;
}

export const list: DonationRouteHandler = async () => ({
  UploadedFile: await uploadedFileService.listFiles(await getOrgId()),
});

export const upload: DonationRouteHandler = async ({ req }) => {
  const chunks = await readCapped(req, MAX_UPLOAD_BYTES + FORM_OVERHEAD_BYTES);
  let form: FormData;
  try {
    form = await new Response(new Blob(chunks), {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw donationError(400, "Expected a multipart upload");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw donationError(400, "file is required");
  if (file.size > MAX_UPLOAD_BYTES) throw tooLarge();
  if (!file.name.toLowerCase().endsWith(".csv") || !CSV_MIME_TYPES.has(file.type.split(";")[0].trim().toLowerCase())) {
    throw donationError(415, "Upload a Benevity .csv file");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  let rows;
  try {
    rows = parseBenevityCsv(buffer);
  } catch (err) {
    if (err instanceof CsvValidationError) throw donationError(400, err.message);
    throw donationError(400, "Could not parse the CSV");
  }
  const audit = await auditContext(req);
  const orgId = await getOrgId();
  const result = await mapServiceErrors(() =>
    uploadedFileService.processUpload(
      orgId, audit.actorUserId, audit.actorUsername, file.name, buffer, rows, audit.correlationId ?? null,
    ),
  );
  return { UploadedFile: { ...result, originalFilename: file.name } };
};

export const download: DonationFileRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  const file = await db.uploadedFile.findFirst({
    where: { id, orgId },
    select: { id: true, orgId: true, originalFilename: true, fileBlob: true },
  });
  if (!file?.fileBlob) throw donationError(404, "File not found");
  await recordDonorDataRead(db, orgId, "uploaded_file", await donorReader(req, "GET /api/donations/uploaded-files/[id]/blob"), {
    ids: [id],
    count: 1,
  });
  return { row: file, contentType: "text/plain", filename: file.originalFilename };
};

export const deleteBlob: DonationRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  return { UploadedFile: await mapServiceErrors(() => uploadedFileService.deleteBlob(orgId, id)) };
};
