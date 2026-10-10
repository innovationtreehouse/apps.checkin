import type { ReceiptState } from "@inventory/receipt-types";
import { z } from "zod";
import { db } from "../db";
import { OcrDataSchema, reimbursementStatusSchema, type OcrData, type OcrResult, type ReceiptPrincipal } from "../contract";
import { sendDonorSync } from "../lib/donor-sync";
import { checkReceiptFile } from "../lib/file-type";
import { insertReceipt, toLineRows, type NewLine } from "../lib/insert";
import { financialReviewReasons, getOrgSettings, pushReceipt, runFullFlow } from "../lib/receipt-flow";
import {
  AddLineItemSchema,
  EditLineItemSchema,
  EditReceiptSchema,
  InKindInputSchema,
  UploadInputSchema,
  type DonorInput,
} from "../lib/schemas";
import { audit, receiptRepo, type ReceiptRow, type ReceiptUpdate } from "../repositories/receipt";
import { getOrg, ports, requireActor } from "../runtime";
import { assertExpectedState, assertLegalTransition, NEUTRAL_CONTEXT, WorkflowTransitionError } from "../workflows/receipt.invariants";
import type { ReceiptEvent } from "../workflows/receipt.events";
import { ReceiptStateConflictError, ServiceError } from "./serviceError";

/**
 * Who the route admitted. `submitter` sees and acts on only the caller's own receipts;
 * `finance` acts org-wide. Authorization itself is the host route's; this narrows the rows.
 */
export type Access = "submitter" | "finance";

const EDITABLE: ReadonlySet<string> = new Set(["validation_failed", "submitter_review"]);
const NEEDS_ATTENTION = ["duplicate_flagged", "validation_failed", "submitter_review", "ocr_failed", "flow_error"];

/** The receipt as a submitter sees it: donor names are pii, read by finance only. */
export type SubmitterReceipt = Omit<ReceiptRow, "donorFirstName" | "donorLastName" | "donorCompanyName">;

function toSubmitterView(row: ReceiptRow): SubmitterReceipt {
  const { donorFirstName: _f, donorLastName: _l, donorCompanyName: _c, ...rest } = row;
  return rest;
}

const toCents = (dollars: number | string | undefined): number =>
  Math.round((typeof dollars === "string" ? parseFloat(dollars) || 0 : (dollars ?? 0)) * 100);

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ServiceError(400, result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return result.data;
}

function transitionError(err: unknown): never {
  if (err instanceof WorkflowTransitionError) throw new ServiceError(400, err.message);
  if (err instanceof ReceiptStateConflictError) throw new ServiceError(409, err.message);
  throw err;
}

async function load(id: string, access: Access, actor: ReceiptPrincipal): Promise<ReceiptRow> {
  const row = await receiptRepo.find(id, (await getOrg()).id, access === "submitter" ? actor.id : undefined);
  if (!row) throw new ServiceError(404, "Receipt not found");
  return row;
}

/** Move along one machine edge with a compare-and-set on the current state, then audit. */
async function step(
  row: ReceiptRow,
  event: ReceiptEvent,
  expected: ReceiptState,
  set: ReceiptUpdate,
  actor: ReceiptPrincipal,
  action: string,
  valueAfter: string | null = null,
): Promise<void> {
  try {
    assertLegalTransition(row.state, event);
    assertExpectedState(row.state, event, NEUTRAL_CONTEXT, expected);
    await receiptRepo.update(row.id, { core: set.core, detail: { ...set.detail, state: expected } }, row.state);
  } catch (e) {
    transitionError(e);
  }
  await audit(db, row.id, actor, { action, valueAfter });
}

function refuseSelfDecision(row: ReceiptRow, actor: ReceiptPrincipal): void {
  if (row.uploadedByUserId === actor.id) throw new ServiceError(409, "You cannot decide on a receipt you uploaded");
}

function donorNames(donor: DonorInput, actor: ReceiptPrincipal) {
  return "self" in donor
    ? { donorFirstName: actor.firstName, donorLastName: actor.lastName, donorCompanyName: null }
    : { donorFirstName: donor.firstName, donorLastName: donor.lastName, donorCompanyName: donor.companyName || null };
}

function ocrDetail(data: OcrData) {
  return {
    retailer: data.retailer,
    receiptNumber: data.receiptNumber ?? null,
    orderNumber: data.orderNumber ?? null,
    receiptDate: data.receiptDate,
    currency: data.currency,
    shippingCents: toCents(data.shipping),
    taxCents: toCents(data.tax),
    discountCents: toCents(data.discount),
    receiptTotalCents: toCents(data.receiptTotal),
  };
}

const toLine = (li: { description: string; partNumber?: string | null; manufacturer?: string | null; quantity?: number; unitPrice?: number; isDelayed?: boolean }): NewLine => ({
  description: li.description,
  partNumber: li.partNumber,
  manufacturer: li.manufacturer,
  quantity: li.quantity ?? 1,
  unitPriceCents: toCents(li.unitPrice),
  isDelayed: li.isDelayed,
});

/** Read the file from `auto_upload` and land in `uploaded` (then the pipeline) or `ocr_failed`. */
async function applyOcr(id: string, actor: ReceiptPrincipal): Promise<void> {
  const file = await db.receipt.findUniqueOrThrow({ where: { id }, select: { fileBlob: true, mimeType: true } });
  const raw = await ports().ocr.extract(Buffer.from(file.fileBlob), file.mimeType);
  const parsed = raw.success ? OcrDataSchema.safeParse(raw.data) : null;
  const result: OcrResult = !raw.success
    ? raw
    : parsed?.success
      ? { success: true, data: parsed.data }
      : { success: false, error: "OCR returned invalid receipt data" };
  if (result.success) {
    assertExpectedState("auto_upload", { type: "OCR_SUCCEEDED" }, NEUTRAL_CONTEXT, "uploaded");
    await db.$transaction(async (tx) => {
      const moved = await tx.receiptDetail.updateMany({
        where: { id, state: "auto_upload" },
        data: { ...ocrDetail(result.data), state: "uploaded", validationNotes: null },
      });
      if (moved.count === 0) throw new ServiceError(409, "Receipt left OCR while it was being read");
      await tx.receiptLineItem.deleteMany({ where: { receiptId: id } });
      await tx.receipt.update({ where: { id }, data: { lineItems: { create: toLineRows(result.data.lineItems.map(toLine)) } } });
      await audit(tx, id, actor, { action: "ocr_complete" });
    });
    await runFullFlow(id, actor);
  } else {
    assertExpectedState("auto_upload", { type: "OCR_FAILED" }, NEUTRAL_CONTEXT, "ocr_failed");
    await db.$transaction(async (tx) => {
      await tx.receiptDetail.updateMany({
        where: { id, state: "auto_upload" },
        data: { state: "ocr_failed", validationNotes: `OCR failed: ${result.error}` },
      });
      await audit(tx, id, actor, { action: "ocr_failed", valueAfter: result.error });
    });
  }
}

async function runFlowLogged(id: string, actor: ReceiptPrincipal): Promise<void> {
  await runFullFlow(id, actor).catch((err: unknown) => {
    console.error(`[receipt] pipeline failed for ${id}:`, err);
  });
}

export const receiptService = {
  /**
   * Upload a receipt. With `details` it is manual: insert at `uploaded` and run the pipeline.
   * Without, it is auto: insert at `auto_upload` and read it with OCR in this request.
   */
  async upload(file: Buffer, declaredType: string, rawInput: unknown) {
    const actor = await requireActor();
    const input = parse(UploadInputSchema, rawInput);
    const check = checkReceiptFile(file, declaredType);
    if (!check.ok) throw new ServiceError(400, check.error);
    if (input.needsReimbursement && !actor.isAdult) throw new ServiceError(400, "Reimbursement is not available for this account");

    const reimbursement = input.needsReimbursement
      ? { needsReimbursement: true, reimbursementFor: actor.name ?? `${actor.firstName} ${actor.lastName}`, reimburseePersonId: actor.id }
      : {};
    const inKind = input.isInKind && input.donor ? { isInKind: true, donorSync: "pending", ...donorNames(input.donor, actor) } : {};
    const d = input.details;

    const id = await insertReceipt({
      orgId: (await getOrg()).id,
      actor,
      file,
      mimeType: check.mimeType,
      core: { ...reimbursement, ...inKind, intakeSource: "upload" },
      detail: d
        ? {
            retailer: d.retailer,
            receiptDate: d.receiptDate,
            currency: d.currency || "USD",
            shippingCents: toCents(d.shipping),
            taxCents: toCents(d.tax),
            discountCents: toCents(d.discount),
            receiptTotalCents: toCents(d.receiptTotal),
            state: "uploaded",
          }
        : { state: "auto_upload", ocrStartedAt: new Date() },
      lines: d ? d.lineItems.map(toLine) : [],
      auditAction: "uploaded",
    });

    if (input.isInKind) await sendDonorSync(id, actor);
    if (d) await runFlowLogged(id, actor);
    else await applyOcr(id, actor);
    return toSubmitterView(await load(id, "submitter", actor));
  },

  async edit(id: string, access: Access, rawUpdates: unknown) {
    const actor = await requireActor();
    const updates = parse(EditReceiptSchema, rawUpdates);
    const row = await load(id, access, actor);
    if (!EDITABLE.has(row.state)) {
      throw new ServiceError(400, "Receipt can only be edited in validation_failed or submitter_review state");
    }
    // The tax amount drives financial review, so only finance may change it.
    if (access === "submitter" && updates.tax !== undefined && toCents(updates.tax) !== row.taxCents) {
      throw new ServiceError(400, "Only finance can change the tax");
    }

    const next = {
      retailer: updates.retailer,
      receiptDate: updates.receiptDate,
      currency: updates.currency,
      shippingCents: updates.shipping === undefined ? undefined : toCents(updates.shipping),
      taxCents: updates.tax === undefined ? undefined : toCents(updates.tax),
      discountCents: updates.discount === undefined ? undefined : toCents(updates.discount),
      receiptTotalCents: updates.receiptTotal === undefined ? undefined : toCents(updates.receiptTotal),
    };
    const changed = Object.entries(next).filter(
      ([k, v]) => v !== undefined && String(row[k as keyof typeof next]) !== String(v),
    );
    if (changed.length === 0) return load(id, access, actor);

    await db.$transaction(async (tx) => {
      await tx.receiptDetail.update({ where: { id }, data: next });
      for (const [field, after] of changed) {
        await audit(tx, id, actor, {
          action: "field_edit",
          fieldChanged: field,
          valueBefore: String(row[field as keyof typeof next]),
          valueAfter: String(after),
        });
      }
    });
    return load(id, access, actor);
  },

  async addLine(id: string, access: Access, rawLine: unknown) {
    const actor = await requireActor();
    const line = parse(AddLineItemSchema, rawLine);
    const row = await load(id, access, actor);
    if (!EDITABLE.has(row.state)) {
      throw new ServiceError(400, "Can only add lines in validation_failed or submitter_review state");
    }
    return db.$transaction(async (tx) => {
      const count = await tx.receiptLineItem.count({ where: { receiptId: id } });
      if (count >= 200) throw new ServiceError(400, "At most 200 line items");
      const last = await tx.receiptLineItem.aggregate({ where: { receiptId: id }, _max: { lineNumber: true } });
      const [data] = toLineRows([{ ...toLine(line), lineNumber: (last._max.lineNumber ?? 0) + 1 }]);
      const created = await tx.receiptLineItem.create({ data: { ...data, receiptId: id } });
      await audit(tx, id, actor, { action: "line_added", lineItemId: created.id });
      return created;
    });
  },

  async editLine(id: string, access: Access, lineItemId: number, rawLine: unknown) {
    const actor = await requireActor();
    const edit = parse(EditLineItemSchema, rawLine);
    const row = await load(id, access, actor);
    if (!EDITABLE.has(row.state)) {
      throw new ServiceError(400, "Line items can only be edited in validation_failed or submitter_review state");
    }
    const li = await db.receiptLineItem.findFirst({ where: { id: lineItemId, receiptId: id } });
    if (!li) throw new ServiceError(404, "Line item not found");

    const quantity = edit.quantity ?? li.quantity;
    const unitPriceCents = edit.unitPrice === undefined ? li.unitPriceCents : toCents(edit.unitPrice);
    const fields = [
      { field: "description", before: li.description, after: edit.description },
      { field: "partNumber", before: li.partNumber, after: edit.partNumber },
      { field: "manufacturer", before: li.manufacturer, after: edit.manufacturer },
      { field: "quantity", before: li.quantity, after: edit.quantity },
      { field: "unitPrice", before: li.unitPriceCents / 100, after: edit.unitPrice },
      { field: "isDelayed", before: li.isDelayed, after: edit.isDelayed },
    ];

    return db.$transaction(async (tx) => {
      const updated = await tx.receiptLineItem.update({
        where: { id: lineItemId },
        data: {
          description: edit.description ?? li.description,
          partNumber: edit.partNumber === undefined ? li.partNumber : edit.partNumber || null,
          manufacturer: edit.manufacturer === undefined ? li.manufacturer : edit.manufacturer || null,
          quantity,
          unitPriceCents,
          totalPriceCents: Math.round(quantity * unitPriceCents),
          isDelayed: edit.isDelayed ?? li.isDelayed,
        },
      });
      for (const f of fields) {
        if (f.after !== undefined && String(f.before) !== String(f.after)) {
          await audit(tx, id, actor, {
            action: "field_edit",
            fieldChanged: f.field,
            valueBefore: f.before === null ? null : String(f.before),
            valueAfter: f.after === null ? null : String(f.after),
            lineItemId,
          });
        }
      }
      return updated;
    });
  },

  async deleteLine(id: string, access: Access, lineItemId: number): Promise<void> {
    const actor = await requireActor();
    const row = await load(id, access, actor);
    if (!EDITABLE.has(row.state)) {
      throw new ServiceError(400, "Can only delete lines in validation_failed or submitter_review state");
    }
    const li = await db.receiptLineItem.findFirst({ where: { id: lineItemId, receiptId: id } });
    if (!li) throw new ServiceError(404, "Line item not found");
    await db.$transaction(async (tx) => {
      await audit(tx, id, actor, { action: "line_deleted", lineItemId });
      await tx.receiptLineItem.delete({ where: { id: lineItemId } });
    });
  },

  async retryOcr(id: string, access: Access) {
    const actor = await requireActor();
    const row = await load(id, access, actor);
    await step(row, { type: "OCR_RETRY" }, "auto_upload", { detail: { validationNotes: null, ocrStartedAt: new Date() } }, actor, "ocr_retry_started");
    await applyOcr(id, actor);
    return load(id, access, actor);
  },

  async discard(id: string, access: Access) {
    const actor = await requireActor();
    const row = await load(id, access, actor);
    await step(row, { type: "DISCARD" }, "discarded", {}, actor, "discarded");
    return load(id, access, actor);
  },

  /** Finance sign-off. A note is required when the reason is tax; the uploader cannot decide. */
  async approveFinancial(id: string, note?: string | null) {
    const actor = await requireActor();
    const row = await load(id, "finance", actor);
    refuseSelfDecision(row, actor);
    const reasons = row.state === "financial_review" ? financialReviewReasons(row, await getOrgSettings(row.orgId)) : [];
    const trimmed = note?.trim() || null;
    if (reasons.includes("tax") && !trimmed) throw new ServiceError(400, "A note explaining the tax is required");
    await step(row, { type: "FINANCIAL_APPROVED" }, "uploaded", { detail: { approvedAt: new Date() } }, actor, "financial_approved", trimmed);
    await runFullFlow(id, actor);
    return load(id, "finance", actor);
  },

  async rejectFinancial(id: string, reason?: string | null) {
    const actor = await requireActor();
    const row = await load(id, "finance", actor);
    refuseSelfDecision(row, actor);
    const note = reason?.trim() || null;
    await step(row, { type: "REJECT" }, "rejected", { detail: { validationNotes: note } }, actor, "reject_financial", note);
    return load(id, "finance", actor);
  },

  /** A person's decision that this is not a duplicate; the pipeline never re-flags it. */
  async clearDuplicate(id: string) {
    const actor = await requireActor();
    const row = await load(id, "finance", actor);
    refuseSelfDecision(row, actor);
    await step(row, { type: "DUPLICATE_CLEARED" }, "uploaded", { detail: { duplicateFlagClearedAt: new Date() } }, actor, "duplicate_cleared");
    await runFullFlow(id, actor);
    return load(id, "finance", actor);
  },

  async resubmit(id: string, access: Access) {
    const actor = await requireActor();
    const row = await load(id, access, actor);
    await step(row, { type: "RESUBMIT" }, "uploaded", {}, actor, "resubmitted");
    await runFullFlow(id, actor);
    return load(id, access, actor);
  },

  async submitterConfirm(id: string) {
    const actor = await requireActor();
    const row = await load(id, "submitter", actor);
    if (row.needsReimbursement && !row.reimbursementFor?.trim()) {
      throw new ServiceError(400, "reimbursementFor is required when needsReimbursement is set");
    }
    await step(row, { type: "SUBMITTER_CONFIRMED" }, "uploaded", { detail: { reviewedAt: new Date() } }, actor, "submitter_review_confirmed");
    await runFullFlow(id, actor);
    return toSubmitterView(await load(id, "submitter", actor));
  },

  async submitterDiscard(id: string) {
    const actor = await requireActor();
    const row = await load(id, "submitter", actor);
    await step(row, { type: "SUBMITTER_DISCARDED" }, "discarded", {}, actor, "discarded");
    return toSubmitterView(await load(id, "submitter", actor));
  },

  /** "I paid for this myself". The reimbursee is always the uploader, never a body field. */
  async setReimbursement(id: string, rawInput: unknown) {
    const actor = await requireActor();
    const { needsReimbursement } = parse(z.object({ needsReimbursement: z.boolean() }).strict(), rawInput);
    const row = await load(id, "submitter", actor);
    if (row.state !== "submitter_review") throw new ServiceError(400, "Receipt is not in submitter_review state");
    if (needsReimbursement && !actor.isAdult) throw new ServiceError(400, "Reimbursement is not available for this account");
    if (needsReimbursement && row.isInKind) throw new ServiceError(400, "An in-kind receipt cannot be reimbursed");

    await db.$transaction(async (tx) => {
      await tx.receipt.update({
        where: { id },
        data: needsReimbursement
          ? { needsReimbursement, reimbursementFor: actor.name ?? `${actor.firstName} ${actor.lastName}`, reimburseePersonId: actor.id }
          : { needsReimbursement, reimbursementFor: null, reimburseePersonId: null },
      });
      await audit(tx, id, actor, {
        action: "reimbursement_updated",
        fieldChanged: "needsReimbursement",
        valueBefore: String(row.needsReimbursement),
        valueAfter: String(needsReimbursement),
      });
    });
    return toSubmitterView(await load(id, "submitter", actor));
  },

  /** Set or clear the in-kind mark and its donor, then tell donations (X13). */
  async setInKind(id: string, rawInput: unknown) {
    const actor = await requireActor();
    const input = parse(InKindInputSchema, rawInput);
    const row = await load(id, "submitter", actor);
    if (!EDITABLE.has(row.state)) throw new ServiceError(400, "Receipt can only be edited in validation_failed or submitter_review state");
    if (input.isInKind && row.needsReimbursement) throw new ServiceError(400, "An in-kind receipt cannot be reimbursed");
    if (!input.isInKind && row.donorSync === "none") return toSubmitterView(row);

    const donor = input.isInKind && input.donor
      ? donorNames(input.donor, actor)
      : { donorFirstName: null, donorLastName: null, donorCompanyName: null };
    await db.$transaction(async (tx) => {
      await tx.receipt.update({ where: { id }, data: { isInKind: input.isInKind, donorSync: "pending", ...donor } });
      await audit(tx, id, actor, {
        action: "in_kind_updated",
        fieldChanged: "isInKind",
        valueBefore: String(row.isInKind),
        valueAfter: String(input.isInKind),
      });
    });
    await sendDonorSync(id, actor);
    return toSubmitterView(await load(id, "submitter", actor));
  },

  async restartFlow(id: string) {
    const actor = await requireActor();
    const row = await load(id, "finance", actor);
    refuseSelfDecision(row, actor);
    try {
      assertLegalTransition(row.state, { type: "RUN_PIPELINE" });
    } catch (e) {
      transitionError(e);
    }
    await audit(db, id, actor, { action: "flow_restarted" });
    await runFullFlow(id, actor);
    return load(id, "finance", actor);
  },

  /** Manual S1 re-send of one finalized receipt. */
  async push(id: string): Promise<{ pushed: boolean }> {
    const actor = await requireActor();
    const row = await load(id, "finance", actor);
    if (row.state !== "receipt_finalized") throw new ServiceError(400, "Receipt is not finalized");
    return { pushed: await pushReceipt(id, actor) };
  },

  // ── Reads ──────────────────────────────────────────────────────────────────

  async get(id: string, access: Access) {
    const actor = await requireActor();
    const row = await load(id, access, actor);
    const lineItems = await receiptRepo.listLineItems(id);
    const reasons = row.state === "financial_review" ? financialReviewReasons(row, await getOrgSettings(row.orgId)) : [];
    const receipt = access === "finance" ? row : toSubmitterView(row);
    return { ...receipt, lineItems, financialReviewReasons: reasons };
  },

  /**
   * The stored bytes for the file route, with the owner column its scope check reads. Every
   * read is audited; the audit holds no bytes.
   */
  async getFile(id: string, access: Access): Promise<{ fileBlob: Uint8Array; mimeType: string; uploadedByUserId: number }> {
    const actor = await requireActor();
    await load(id, access, actor);
    const file = await db.receipt.findUniqueOrThrow({ where: { id }, select: { fileBlob: true, mimeType: true, uploadedByUserId: true } });
    await audit(db, id, actor, { action: "file_viewed" });
    return file;
  },

  /**
   * "My receipts": the caller's own receipts, each owed one with its QuickBooks paid status.
   * Complete = discarded, rejected, or finalized and either not owed or shown paid.
   */
  async listMine(opts: { hideCompleted?: boolean } = {}) {
    const actor = await requireActor();
    const rows = await receiptRepo.list({ orgId: (await getOrg()).id, uploadedByUserId: actor.id });
    const owed = rows.filter((r) => r.needsReimbursement).map((r) => r.id);
    const paid = owed.length
      ? reimbursementStatusSchema.parse(await ports().reimbursementStatus.forReceipts(owed))
      : new Map<string, { paidOn: string | null }>();

    const list = rows.map((r) => {
      const paidOn = r.needsReimbursement ? (paid.get(r.id)?.paidOn ?? null) : null;
      const complete =
        r.state === "discarded" ||
        r.state === "rejected" ||
        (r.state === "receipt_finalized" && (!r.needsReimbursement || paidOn !== null));
      return { ...toSubmitterView(r), reimbursement: r.needsReimbursement ? { paidOn } : null, complete };
    });
    return opts.hideCompleted ? list.filter((r) => !r.complete) : list;
  },

  async listForOrg() {
    await requireActor();
    return receiptRepo.list({ orgId: (await getOrg()).id });
  },

  /** An unknown state matches no rows. */
  async listByState(state: string) {
    await requireActor();
    return receiptRepo.list({ orgId: (await getOrg()).id, details: { state } });
  },

  async listNeedsAttention(access: Access) {
    const actor = await requireActor();
    const rows = await receiptRepo.list({
      orgId: (await getOrg()).id,
      ...(access === "submitter" ? { uploadedByUserId: actor.id } : {}),
      details: { state: { in: NEEDS_ATTENTION } },
    });
    return access === "finance" ? rows : rows.map(toSubmitterView);
  },

  async listAuditLogs(id: string) {
    const actor = await requireActor();
    await load(id, "finance", actor);
    return receiptRepo.listAuditLogs(id);
  },
};
