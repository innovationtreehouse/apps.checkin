/**
 * The receipt endpoints. The registry gates each route; the services narrow rows by `access`,
 * filter a submitter by the principal's id, and throw ServiceError for every expected failure.
 */
import { httpError, parseId, query, readJson } from "@checkin/component-kit";
import { z } from "zod";
import type { ReceiptFileRouteHandler, ReceiptRouteHandler } from "../contract";
import { parseListFilter } from "../lib/listFilter";
import { importReceipts } from "../services/importService";
import { orgSettingsService } from "../services/orgSettingsService";
import { receiptService } from "../services/receiptService";
import { MAX_UPLOAD_BODY_BYTES, readJsonCapped, readUploadForm } from "./_shared";

/** The org-wide list; `?state=` narrows to one machine state, `?pushed=0|1` to whether it reached receiving. */
export const list: ReceiptRouteHandler = async ({ req }) => ({ ReceiptView: await receiptService.list(parseListFilter(query(req))) });

/** "My receipts". `?hideCompleted=1` drops complete ones; an owed, unpaid receipt always stays. */
export const mine: ReceiptRouteHandler = async ({ req }) => {
  const hideCompleted = ["1", "true"].includes(query(req).get("hideCompleted") ?? "");
  return { ReceiptView: await receiptService.listMine({ hideCompleted }) };
};

export const needsAttention: ReceiptRouteHandler = async ({ access }) => ({ ReceiptView: await receiptService.listNeedsAttention(access) });

/**
 * How many of the org's receipts each review queue holds, for the review screen's tabs. FINANCE's
 * own queues leave out receipts the FINANCE caller is conflicted on; BOARD, which only reads, gets
 * org-wide counts.
 */
export const queueCounts: ReceiptRouteHandler = async ({ financeActorId }) => ({
  ReceiptQueueCounts: await receiptService.queueCounts(financeActorId),
});

/** Reimbursements waiting for the caller's confirmation, as the person reimbursed or a Board member on their behalf. */
export const confirmations: ReceiptRouteHandler = async () => ({ ReceiptConfirmationView: await receiptService.listConfirmations() });

/** Reimbursements naming the caller that someone else uploaded, with what became of each. */
export const reimbursements: ReceiptRouteHandler = async () => ({ ReceiptReimbursedView: await receiptService.listReimbursedToMe() });

/** People matching `?q=`, for naming who is reimbursed on upload. */
export const reimburseeOptions: ReceiptRouteHandler = async ({ req }) => ({
  ReceiptReimburseeOption: await receiptService.reimburseeOptions(query(req).get("q")),
});

export const getSettings: ReceiptRouteHandler = async () => ({ ReceiptOrgSettings: await orgSettingsService.get() });

export const updateSettings: ReceiptRouteHandler = async ({ req }) => ({ ReceiptOrgSettings: await orgSettingsService.update(await readJson(req)) });

/**
 * Multipart: `file` is the receipt, `data` an optional JSON string of the upload input. With
 * `data.details` the upload is manual; without, OCR reads the file in this request.
 */
export const upload: ReceiptRouteHandler = async ({ req }) => {
  const form = await readUploadForm(req);
  const file = form.get("file");
  if (!(file instanceof File)) throw httpError(400, "A receipt file is required");
  const data = form.get("data");
  let input: unknown = {};
  if (typeof data === "string" && data.trim()) {
    try {
      input = JSON.parse(data);
    } catch {
      throw httpError(400, "data must be JSON");
    }
  }
  return { ReceiptView: await receiptService.upload(Buffer.from(await file.arrayBuffer()), file.type, input) };
};

/**
 * Historical bulk import: one result row per receipt; a re-run skips rows already loaded. The
 * whole body, base64 rows included, fits the upload ceiling, so each row's file does too (about
 * 8 MB raw after base64). A batch over it is refused and must be split; a larger receipt goes
 * through the upload route.
 */
export const importBatch: ReceiptRouteHandler = async ({ req }) => {
  const batch = await readJsonCapped(
    req.body,
    req.headers.get("content-length"),
    MAX_UPLOAD_BODY_BYTES,
    "Import batch is over the upload size limit; split it into smaller batches",
  );
  return { ReceiptImportResult: (await importReceipts(batch)).results };
};

export const edit: ReceiptRouteHandler = async ({ req, params, access }) => ({
  ReceiptView: await receiptService.edit(params.id, access, await readJson(req)),
});

export const approve: ReceiptRouteHandler = async ({ params }) => ({ ReceiptView: await receiptService.approveFinancial(params.id) });

const RejectBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

export const reject: ReceiptRouteHandler = async ({ req, params }) => {
  const body = RejectBody.safeParse(await readJson(req));
  if (!body.success) throw httpError(400, "A reason of up to 2000 characters is required to reject a receipt");
  return { ReceiptView: await receiptService.rejectFinancial(params.id, body.data.reason) };
};

export const discard: ReceiptRouteHandler = async ({ params, access }) => ({ ReceiptView: await receiptService.discard(params.id, access) });

export const resubmit: ReceiptRouteHandler = async ({ params, access }) => ({ ReceiptView: await receiptService.resubmit(params.id, access) });

export const retryOcr: ReceiptRouteHandler = async ({ params, access }) => ({ ReceiptView: await receiptService.retryOcr(params.id, access) });

export const restartFlow: ReceiptRouteHandler = async ({ params }) => ({ ReceiptView: await receiptService.restartFlow(params.id) });

export const submitterConfirm: ReceiptRouteHandler = async ({ params }) => ({ ReceiptView: await receiptService.submitterConfirm(params.id) });

export const submitterDiscard: ReceiptRouteHandler = async ({ params }) => ({ ReceiptView: await receiptService.submitterDiscard(params.id) });

/** The uploader acknowledges finance's rejection of their receipt, which leaves their My receipts pill. */
export const acknowledgeRejection: ReceiptRouteHandler = async ({ params }) => ({
  ReceiptView: await receiptService.acknowledgeRejection(params.id),
});

export const confirmation: ReceiptRouteHandler = async ({ req, params }) => {
  const body: unknown = await req.json().catch(() => ({}));
  const reason = typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string" ? body.reason : null;
  return { ReceiptConfirmationView: await receiptService.confirmAsReimbursee(params.id, reason) };
};

export const inKind: ReceiptRouteHandler = async ({ req, params }) => ({ ReceiptView: await receiptService.setInKind(params.id, await readJson(req)) });

export const reimbursement: ReceiptRouteHandler = async ({ req, params }) => ({
  ReceiptView: await receiptService.setReimbursement(params.id, await readJson(req)),
});

export const auditLogs: ReceiptRouteHandler = async ({ params }) => ({ ReceiptAuditLog: await receiptService.listAuditLogs(params.id) });

/** Manual S1 re-send of one finalized receipt. Until X6 is bound it answers `pushed: false`. */
export const pushToInventory: ReceiptRouteHandler = async ({ params }) => ({ ReceiptPushResult: await receiptService.push(params.id) });

export const deleteLine: ReceiptRouteHandler = async ({ params, access }) => {
  await receiptService.deleteLine(params.id, access, parseId(params.lineItemId, "line item id"));
  return {};
};

/** The only way a receipt's bytes leave; the service audits every read. */
export const file: ReceiptFileRouteHandler = async ({ params, access }) => {
  const stored = await receiptService.getFile(params.id, access);
  return {
    row: { fileBlob: stored.fileBlob, uploadedByUserId: stored.uploadedByUserId },
    contentType: stored.mimeType,
    filename: stored.mimeType === "text/plain" ? `receipt-${params.id}.txt` : undefined,
  };
};

export const duplicateGroup: ReceiptRouteHandler = async ({ params }) => ({ ReceiptDuplicateGroup: await receiptService.duplicateGroup(params.id) });

const NotThisOneBody = z.object({ otherId: z.string().min(1) }).strict();

export const notThisOne: ReceiptRouteHandler = async ({ req, params }) => {
  const body = NotThisOneBody.safeParse(await readJson(req));
  if (!body.success) throw httpError(400, "Name the match that is not this one");
  return { ReceiptDuplicateGroup: await receiptService.notThisOne(params.id, body.data.otherId) };
};

export const undoNotThisOne: ReceiptRouteHandler = async ({ params }) => ({
  ReceiptDuplicateGroup: await receiptService.undoNotThisOne(params.id, params.otherId),
});

const ShownIdsBody = z.object({ shownIds: z.array(z.string().min(1)).min(1).max(100) }).strict();

export const differentPurchases: ReceiptRouteHandler = async ({ req, params }) => {
  const body = ShownIdsBody.safeParse(await readJson(req));
  if (!body.success) throw httpError(400, "Send the ids of the receipts the panel showed");
  return { ReceiptView: await receiptService.differentPurchases(params.id, body.data.shownIds) };
};

export const keepThisOne: ReceiptRouteHandler = async ({ req, params }) => {
  const body = ShownIdsBody.safeParse(await readJson(req));
  if (!body.success) throw httpError(400, "Send the ids of the receipts the panel showed");
  return { ReceiptView: await receiptService.keepThisOne(params.id, body.data.shownIds) };
};
