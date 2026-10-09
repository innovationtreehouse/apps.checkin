/** Benevity uploads: list, import, the stored-CSV download, and dropping an all-duplicate blob. */
import { db } from "../db";
import { CsvValidationError, parseBenevityCsv } from "../lib/csv-parser";
import { recordDonorDataRead } from "../repositories/audit";
import { uploadedFileService } from "../services/uploadedFileService";
import { donationError, getOrgId, mapServiceErrors } from "../runtime";
import type { DonationFileRouteHandler, DonationRouteHandler } from "../contract";
import { auditContext, donorReader, parseId } from "./_shared";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const list: DonationRouteHandler = async () => ({
  UploadedFile: await uploadedFileService.listFiles(await getOrgId()),
});

export const upload: DonationRouteHandler = async ({ req }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw donationError(400, "Expected a multipart upload");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw donationError(400, "file is required");
  if (file.size > MAX_UPLOAD_BYTES) throw donationError(413, "File is larger than 10 MB");
  const buffer = Buffer.from(await file.arrayBuffer());
  let rows;
  try {
    rows = parseBenevityCsv(buffer);
  } catch (err) {
    if (err instanceof CsvValidationError) throw donationError(400, err.message);
    throw donationError(400, "Could not parse the CSV");
  }
  const audit = await auditContext(req);
  const result = await uploadedFileService.processUpload(
    await getOrgId(), audit.actorUserId, audit.actorUsername, file.name, buffer, rows, audit.correlationId ?? null,
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
