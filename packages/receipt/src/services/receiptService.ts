import { isServiceError, ServiceError } from "@checkin/component-kit";
import type { ReceiptState } from "@checkin/receipt-types";
import { z } from "zod";
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import {
  OcrDataSchema,
  reimbursementStatusSchema,
  type OcrData,
  type OcrResult,
  type PaidStatus,
  type ReceiptPrincipal,
  type ReimbursementAsk,
  type ReimburseeOption,
} from "../contract";
import { sendDonorSync } from "../lib/donor-sync";
import { duplicateGroup as computeGroup, type DuplicateGroup } from "../lib/duplicateGroup";
import { checkReceiptFile } from "../lib/file-type";
import { insertReceipt, toLineRows, type NewLine } from "../lib/insert";
import { listFilterWhere, type ReceiptListFilter } from "../lib/listFilter";
import { givenUp, pushRecords } from "./catchUp";
import { BODY_COPY_DISCARDED, financialReviewReasons, getOrgSettings, pushReceipt, runFullFlow, SUBMITTER_CORRECTION_FIELDS } from "../lib/receipt-flow";
import { listWords, missingDetails } from "../lib/missingDetails";
import {
  AddLineItemSchema,
  EditLineItemSchema,
  EditReceiptSchema,
  InKindInputSchema,
  UploadInputSchema,
  type DonorInput,
} from "../lib/schemas";
import { audit, ReceiptStateConflictError, receiptRepo, type ReceiptRow, type ReceiptUpdate } from "../repositories/receipt";
import { getOrg, limits, ports, requireActor } from "../runtime";
import { DAY_MS } from "../lib/limits";
import { assertExpectedState, assertLegalTransition, NEUTRAL_CONTEXT, WorkflowTransitionError } from "../workflows/receipt.invariants";
import type { ReceiptEvent } from "../workflows/receipt.events";
import { FINANCE_ACTION_STATES, SUBMITTER_ACTION_STATES } from "../nav";

/**
 * Who the route admitted. `submitter` sees and acts on only the caller's own receipts;
 * `finance` acts org-wide. Authorization itself is the host route's; this narrows the rows.
 */
export type Access = "submitter" | "finance";

/** Receipts waiting on one FINANCE viewer: all of them, and per FINANCE_ACTION_STATES state. */
export type FinanceCounts = { total: number; byState: Record<string, number> };

const EDITABLE: ReadonlySet<string> = new Set(["validation_failed", "submitter_review"]);
const NEEDS_ATTENTION = ["duplicate_flagged", "validation_failed", "submitter_review", "ocr_failed", "flow_error"];

/** The receipt as a submitter sees it: donor names are pii, read by finance only. */
export type SubmitterReceipt = Omit<ReceiptRow, "donorFirstName" | "donorLastName" | "donorCompanyName">;

function toSubmitterView(row: ReceiptRow): SubmitterReceipt {
  const { donorFirstName: _f, donorLastName: _l, donorCompanyName: _c, ...rest } = row;
  return rest;
}

/** X12 answer; QuickBooks off or any failure reads "not yet paid", never an error on the page. */
async function paidStatus(owed: ReimbursementAsk[]): Promise<Map<string, PaidStatus>> {
  try {
    return reimbursementStatusSchema.parse(await ports().reimbursementStatus.forReceipts(owed));
  } catch (err) {
    console.warn("[receipt] reimbursement status unavailable", err);
    return new Map();
  }
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

/**
 * Load a receipt to change it. Once workflow-mapping has received it, it is fixed here: the
 * callee keeps the first delivery, so a changed re-push would be silently dropped.
 */
async function loadForChange(id: string, access: Access, actor: ReceiptPrincipal): Promise<ReceiptRow> {
  const row = await load(id, access, actor);
  if (row.pushedAt) throw new ServiceError(409, "This receipt was already sent to part mapping and can no longer be changed");
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

/** An audited 403: the attempt is on the receipt's record even though nothing changed. */
async function refuse(row: ReceiptRow, actor: ReceiptPrincipal, attempted: string, message: string): Promise<never> {
  await audit(db, row.id, actor, { action: "decision_refused", valueAfter: attempted });
  throw new ServiceError(403, message);
}

type Parties = Pick<ReceiptRow, "uploadedByUserId" | "reimburseePersonId">;

/** The uploader, the reimbursee, and everyone in either one's household. */
async function conflictedParties(row: Parties): Promise<number[]> {
  const parties = [row.uploadedByUserId, row.reimburseePersonId].filter((id): id is number => id != null);
  return [...parties, ...(await ports().households.householdOf(parties))];
}

/** The receipt write that records finance's decision, replacing any earlier one. */
function recordFinanceReview(
  outcome: "approved" | "rejected",
  row: ReceiptRow,
  reasons: string[],
  actor: ReceiptPrincipal,
  note: string | null,
  decidedAt: Date,
): Prisma.ReceiptUncheckedUpdateInput {
  const review = { outcome, reasons, decidedByUserId: actor.id, note, taxCents: row.taxCents, decidedAt };
  return { financeReview: { upsert: { create: review, update: review } } };
}

async function refuseSelfDecision(row: ReceiptRow, actor: ReceiptPrincipal, attempted: string): Promise<void> {
  if (!(await conflictedParties(row)).includes(actor.id)) return;
  await refuse(row, actor, attempted, "You cannot decide on a receipt that you or your household uploaded or is reimbursed for");
}

/**
 * The access a write runs with. Finance on a receipt it is party to holds no finance rights:
 * the uploader acts as its submitter, and anyone else conflicted is refused.
 */
async function writeAccess(row: ReceiptRow, access: Access, actor: ReceiptPrincipal, attempted: string): Promise<Access> {
  if (access === "submitter" || row.uploadedByUserId === actor.id) return "submitter";
  await refuseSelfDecision(row, actor, attempted);
  return "finance";
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
    receiptTotalCents: data.receiptTotal === null ? null : toCents(data.receiptTotal),
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

/**
 * Spends one of the caller's daily model calls, or refuses with 429. Each call is an audit row,
 * so the count survives restarts and is shared by every app process; a per-person lock keeps
 * concurrent requests from all passing the same check.
 */
async function reserveOcrCall(actor: ReceiptPrincipal): Promise<void> {
  const { ocrCallsPerPersonPerDay } = limits();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`receipt-ocr:${actor.id}`}, 0))`;
    const used = await tx.receiptAuditLog.count({
      where: { userId: actor.id, action: "ocr_call", changedAt: { gt: new Date(Date.now() - DAY_MS) } },
    });
    if (used >= ocrCallsPerPersonPerDay) {
      throw new ServiceError(429, "You have reached today's limit for automatic reading. Type the details, or try again tomorrow.");
    }
    await tx.receiptAuditLog.create({ data: { receiptId: null, userId: actor.id, username: actor.name, action: "ocr_call" } });
  });
}

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
    await failOcr(id, actor, result.error);
  }
}

async function failOcr(id: string, actor: ReceiptPrincipal, error: string): Promise<void> {
  assertExpectedState("auto_upload", { type: "OCR_FAILED" }, NEUTRAL_CONTEXT, "ocr_failed");
  await db.$transaction(async (tx) => {
    await tx.receiptDetail.updateMany({
      where: { id, state: "auto_upload" },
      data: { state: "ocr_failed", validationNotes: `OCR failed: ${error}` },
    });
    await audit(tx, id, actor, { action: "ocr_failed", valueAfter: error });
  });
}

/**
 * A mailed file enters as an auto upload by its sender: the upload limits (counting mailed receipts
 * per person against the sender's mail limit), duplicate check and audit of a manual upload, then OCR on the sender's daily allowance. `ledger` runs inside the
 * insert, so the receipt and its mail-ledger row exist together or not at all. A file over the
 * OCR allowance lands in `ocr_failed`, where its uploader types the details. `uploadLimits: false`
 * skips the daily upload limits for this one file, for a deferred file finance releases.
 * `mailAllowance: false` checks the manual upload limits in place of the mail limit, for a file
 * finance assigns.
 */
export async function intakeMailedReceipt(
  actor: ReceiptPrincipal,
  file: Buffer,
  mimeType: string,
  ledger: (tx: Prisma.TransactionClient, receiptId: string) => Promise<unknown>,
  { uploadLimits = true, mailAllowance = true }: { uploadLimits?: boolean; mailAllowance?: boolean } = {},
): Promise<string> {
  const id = await insertReceipt({
    orgId: (await getOrg()).id,
    actor,
    file,
    mimeType,
    core: { intakeSource: "email" },
    detail: { state: "auto_upload", ocrStartedAt: new Date() },
    lines: [],
    auditAction: "mail_intake",
    limits: uploadLimits ? limits() : undefined,
    mailLimit:
      uploadLimits && mailAllowance
        ? actor.raisedMailLimit
          ? limits().mailUploadsPerRaisedPersonPerDay
          : limits().mailUploadsPerPersonPerDay
        : undefined,
    afterInsert: ledger,
  });
  try {
    await reserveOcrCall(actor);
  } catch (err) {
    if (!(isServiceError(err) && err.status === 429)) throw err;
    await failOcr(id, actor, "daily limit reached");
    return id;
  }
  // A failed read leaves the receipt in auto_upload, where the interrupted-OCR sweep finds it.
  await applyOcr(id, actor).catch((err: unknown) => console.error(`[receipt] OCR failed for ${id}:`, err));
  return id;
}

/**
 * Discard a mailed body receipt when its reading has the same total and date as a receipt from
 * the same message; a reading missing either keeps it. A system step, audited naming the match.
 */
export async function discardBodyCopy(id: string, siblingIds: string[]): Promise<boolean> {
  const orgId = (await getOrg()).id;
  const row = await receiptRepo.find(id, orgId);
  if (!row || row.receiptTotalCents == null || !row.receiptDate || row.pushedAt || siblingIds.length === 0) return false;
  const siblings = await receiptRepo.list({ id: { in: siblingIds }, orgId });
  const match = siblings.find((s) => s.receiptTotalCents === row.receiptTotalCents && s.receiptDate === row.receiptDate);
  if (!match) return false;
  try {
    assertLegalTransition(row.state, { type: "DISCARD" });
  } catch (e) {
    transitionError(e);
  }
  // The audit row marks the copy for checkDuplicate, so it commits with the state change.
  return db.$transaction(async (tx) => {
    const moved = await tx.receiptDetail.updateMany({ where: { id, state: row.state }, data: { state: "discarded" } });
    if (moved.count !== 1) return false;
    await audit(tx, id, null, { action: BODY_COPY_DISCARDED, valueAfter: `same as attachment ${match.id}` });
    return true;
  });
}

/** The person the uploader names as reimbursee: themselves unless they picked a live adult. */
async function namedReimbursee(actor: ReceiptPrincipal, personId: number | undefined): Promise<ReimburseeOption> {
  if (personId === undefined || personId === actor.id) {
    return { id: actor.id, name: actor.name ?? `${actor.firstName} ${actor.lastName}` };
  }
  const person = await ports().reimbursees.byId(personId);
  if (!person) throw new ServiceError(400, "The person to reimburse was not found");
  if (!person.isAdult) throw new ServiceError(400, `${person.name} cannot be reimbursed: only an adult can be`);
  return { id: person.id, name: person.name };
}

/** At most this many people answer one reimbursee search. */
const REIMBURSEE_SEARCH_LIMIT = 20;

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

    const reimbursee = input.needsReimbursement ? await namedReimbursee(actor, input.reimburseePersonId) : null;
    const reimbursement = reimbursee
      ? { needsReimbursement: true, reimbursementFor: reimbursee.name, reimburseePersonId: reimbursee.id }
      : {};
    const inKind = input.isInKind && input.donor ? { isInKind: true, donorSync: "pending", ...donorNames(input.donor, actor) } : {};
    const d = input.details;
    if (!d) await reserveOcrCall(actor);

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
      limits: limits(),
      afterInsert: reimbursee
        ? (tx, receiptId) =>
            audit(tx, receiptId, actor, { action: "reimbursee_named", fieldChanged: "reimburseePersonId", valueAfter: String(reimbursee.id) })
        : undefined,
    });

    if (input.isInKind) await sendDonorSync(id, actor);
    if (d) await runFlowLogged(id, actor);
    else await applyOcr(id, actor);
    return toSubmitterView(await load(id, "submitter", actor));
  },

  async edit(id: string, access: Access, rawUpdates: unknown) {
    const actor = await requireActor();
    const updates = parse(EditReceiptSchema, rawUpdates);
    const row = await loadForChange(id, access, actor);
    if (!EDITABLE.has(row.state)) {
      throw new ServiceError(400, "Receipt can only be edited in validation_failed or submitter_review state");
    }
    const asSubmitter = (await writeAccess(row, access, actor, "edit")) === "submitter";

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
    // A submitter's tax or date correction needs a fresh finance review.
    const reopensReview = asSubmitter && changed.some(([field]) => SUBMITTER_CORRECTION_FIELDS.includes(field));

    await db.$transaction(async (tx) => {
      await tx.receiptDetail.update({ where: { id }, data: reopensReview ? { ...next, approvedAt: null } : next });
      if (reopensReview) await tx.receiptFinanceReview.deleteMany({ where: { receiptId: id } });
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
    const row = await loadForChange(id, access, actor);
    if (!EDITABLE.has(row.state)) {
      throw new ServiceError(400, "Can only add lines in validation_failed or submitter_review state");
    }
    await writeAccess(row, access, actor, "add line");
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
    const row = await loadForChange(id, access, actor);
    if (!EDITABLE.has(row.state)) {
      throw new ServiceError(400, "Line items can only be edited in validation_failed or submitter_review state");
    }
    await writeAccess(row, access, actor, "edit line");
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
    const row = await loadForChange(id, access, actor);
    if (!EDITABLE.has(row.state)) {
      throw new ServiceError(400, "Can only delete lines in validation_failed or submitter_review state");
    }
    await writeAccess(row, access, actor, "delete line");
    const li = await db.receiptLineItem.findFirst({ where: { id: lineItemId, receiptId: id } });
    if (!li) throw new ServiceError(404, "Line item not found");
    await db.$transaction(async (tx) => {
      await audit(tx, id, actor, { action: "line_deleted", lineItemId });
      await tx.receiptLineItem.delete({ where: { id: lineItemId } });
    });
  },

  async retryOcr(id: string, access: Access) {
    const actor = await requireActor();
    const row = await loadForChange(id, access, actor);
    await writeAccess(row, access, actor, "retry ocr");
    try {
      assertLegalTransition(row.state, { type: "OCR_RETRY" });
    } catch (e) {
      transitionError(e);
    }
    await reserveOcrCall(actor);
    await step(row, { type: "OCR_RETRY" }, "auto_upload", { detail: { validationNotes: null, ocrStartedAt: new Date() } }, actor, "ocr_retry_started");
    await applyOcr(id, actor);
    return load(id, access, actor);
  },

  /** The uploader withdraws their own receipt; anyone else who can see it is refused. */
  async discard(id: string, access: Access) {
    const actor = await requireActor();
    const row = await loadForChange(id, access, actor);
    if (row.uploadedByUserId !== actor.id) await refuse(row, actor, "discard", "Only the person who uploaded a receipt can discard it");
    await step(row, { type: "DISCARD" }, "discarded", {}, actor, "discarded");
    return load(id, access, actor);
  },

  /** Finance sign-off; no conflicted party can decide. */
  async approveFinancial(id: string) {
    const actor = await requireActor();
    const row = await loadForChange(id, "finance", actor);
    await refuseSelfDecision(row, actor, "approve");
    const reasons = row.state === "financial_review" ? await financialReviewReasons(row, await getOrgSettings(row.orgId)) : [];
    const now = new Date();
    const set = { core: recordFinanceReview("approved", row, reasons, actor, null, now), detail: { approvedAt: now } };
    await step(row, { type: "FINANCIAL_APPROVED" }, "uploaded", set, actor, "financial_approved");
    await runFullFlow(id, actor);
    return load(id, "finance", actor);
  },

  /**
   * Finance refuses an open receipt, with a reason. Rejecting a suspected original decides each
   * duplicate flagged against it, so a party to any of those is refused, and each one's log records it.
   */
  async rejectFinancial(id: string, reason: string) {
    const note = reason.trim();
    if (!note) throw new ServiceError(400, "A reason is required to reject a receipt");
    const actor = await requireActor();
    const row = await loadForChange(id, "finance", actor);
    await refuseSelfDecision(row, actor, "reject");
    const flaggedAgainst = await receiptRepo.list({ orgId: row.orgId, details: { duplicateSuspectReceiptId: row.id, state: "duplicate_flagged" } });
    for (const flagged of flaggedAgainst) await refuseSelfDecision(flagged, actor, "reject the suspected original");
    const reasons = row.state === "financial_review" ? await financialReviewReasons(row, await getOrgSettings(row.orgId)) : [];
    const set = { core: recordFinanceReview("rejected", row, reasons, actor, note, new Date()), detail: { validationNotes: note } };
    await step(row, { type: "REJECT" }, "rejected", set, actor, "reject_financial", note);
    for (const flagged of flaggedAgainst) await audit(db, flagged.id, actor, { action: "suspected_original_rejected", valueAfter: row.id });
    return load(id, "finance", actor);
  },

  /**
   * A person's decision that this receipt and each live member of its group are different
   * purchases, recorded per pair; a copy arriving later is still matched against it.
   */
  async clearDuplicate(id: string) {
    const actor = await requireActor();
    const row = await loadForChange(id, "finance", actor);
    await refuseSelfDecision(row, actor, "clear duplicate");
    try {
      assertLegalTransition(row.state, { type: "DUPLICATE_CLEARED" });
    } catch (e) {
      transitionError(e);
    }
    const others =((await computeGroup(row.orgId, id))?.members ?? []).filter((m) => m.id !== id && m.state !== "discarded");
    await db.receiptPairDecision.createMany({
      data: others.map((m) => ({
        orgId: row.orgId,
        receiptId: id < m.id ? id : m.id,
        otherReceiptId: id < m.id ? m.id : id,
        kind: "different",
        decidedByUserId: actor.id,
      })),
      skipDuplicates: true,
    });
    await step(row, { type: "DUPLICATE_CLEARED" }, "uploaded", { detail: { duplicateFlagClearedAt: new Date() } }, actor, "duplicate_cleared");
    await runFullFlow(id, actor);
    return load(id, "finance", actor);
  },

  /** People matching the typed name, for naming the reimbursee on upload. Under two characters matches nobody. */
  async reimburseeOptions(rawQuery: string | null): Promise<ReimburseeOption[]> {
    await requireActor();
    const query = (rawQuery ?? "").trim().slice(0, 100);
    if (query.length < 2) return [];
    return ports().reimbursees.search(query, REIMBURSEE_SEARCH_LIMIT);
  },

  async resubmit(id: string, access: Access) {
    const actor = await requireActor();
    const row = await loadForChange(id, access, actor);
    await writeAccess(row, access, actor, "resubmit");
    await step(row, { type: "RESUBMIT" }, "uploaded", {}, actor, "resubmitted");
    await runFullFlow(id, actor);
    return load(id, access, actor);
  },

  async submitterConfirm(id: string) {
    const actor = await requireActor();
    const row = await loadForChange(id, "submitter", actor);
    if (row.needsReimbursement && !row.reimbursementFor?.trim()) {
      throw new ServiceError(400, "reimbursementFor is required when needsReimbursement is set");
    }
    const missing = missingDetails(row);
    if (missing.length > 0) throw new ServiceError(400, `Fill in the ${listWords(missing)} before confirming this receipt`);
    await step(row, { type: "SUBMITTER_CONFIRMED" }, "uploaded", { detail: { reviewedAt: new Date(), validationNotes: null } }, actor, "submitter_review_confirmed");
    await runFullFlow(id, actor);
    return toSubmitterView(await load(id, "submitter", actor));
  },

  async submitterDiscard(id: string) {
    const actor = await requireActor();
    const row = await loadForChange(id, "submitter", actor);
    await step(row, { type: "SUBMITTER_DISCARDED" }, "discarded", {}, actor, "discarded");
    return toSubmitterView(await load(id, "submitter", actor));
  },

  /** "I paid for this myself": ticking it names the uploader as reimbursee. */
  async setReimbursement(id: string, rawInput: unknown) {
    const actor = await requireActor();
    const { needsReimbursement } = parse(z.object({ needsReimbursement: z.boolean() }).strict(), rawInput);
    const row = await loadForChange(id, "submitter", actor);
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
    const row = await loadForChange(id, "submitter", actor);
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
    const row = await loadForChange(id, "finance", actor);
    await refuseSelfDecision(row, actor, "restart flow");
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

  /** The receipt's duplicate group (design §5.1). Org-wide: the host route admits finance only. */
  async duplicateGroup(id: string): Promise<DuplicateGroup> {
    await requireActor();
    const group = await computeGroup((await getOrg()).id, id);
    if (!group) throw new ServiceError(404, "Receipt not found");
    return group;
  },

  async get(id: string, access: Access) {
    const actor = await requireActor();
    const row = await load(id, access, actor);
    const lineItems = await receiptRepo.listLineItems(id);
    const reasons = row.state === "financial_review" ? await financialReviewReasons(row, await getOrgSettings(row.orgId)) : [];
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
    const owed = rows.filter((r) => r.needsReimbursement).map((r) => ({ receiptId: r.id, qbEntity: r.qbEntity, qbTxnId: r.qbTxnId }));
    const paid = owed.length ? await paidStatus(owed) : new Map<string, PaidStatus>();

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

  /**
   * The org's receipts narrowed by `filter`; an unknown state matches no rows. A finalized
   * receipt not yet delivered to receiving carries its push record.
   */
  async list(filter: ReceiptListFilter) {
    await requireActor();
    const orgId = (await getOrg()).id;
    const rows = await receiptRepo.list(listFilterWhere(orgId, filter));
    const undelivered = rows.filter((r) => r.state === "receipt_finalized" && !r.pushedAt).map((r) => r.id);
    const records = await pushRecords(orgId, undelivered);
    return rows.map((r) => ({ ...r, ...records.get(r.id) }));
  },

  /**
   * How many of the org's receipts each review queue holds, for the review screen's tabs. For a
   * FINANCE viewer the queues that wait on FINANCE leave out receipts the viewer is conflicted on,
   * matching the nav pill; every other count is org-wide.
   */
  async queueCounts(financeViewerId: number | null): Promise<{ byState: Record<string, number>; notPushed: number; pushGivenUp: number }> {
    await requireActor();
    const orgId = (await getOrg()).id;
    const [groups, undelivered, finance] = await Promise.all([
      db.receiptDetail.groupBy({ by: ["state"], where: { orgId }, _count: { _all: true } }),
      db.receipt.findMany({ where: { orgId, pushedAt: null, details: { state: "receipt_finalized" } }, select: { id: true } }),
      financeViewerId === null ? null : receiptService.countAwaitingFinance(financeViewerId),
    ]);
    const stopped = await givenUp(orgId, undelivered.map((r) => r.id));
    const byState: Record<string, number> = Object.fromEntries(groups.map((g) => [g.state, g._count._all]));
    if (finance) for (const state of FINANCE_ACTION_STATES) byState[state] = finance.byState[state] ?? 0;
    return {
      byState,
      notPushed: undelivered.length,
      pushGivenUp: stopped.size,
    };
  },

  /**
   * How many of the org's receipts wait on this FINANCE viewer, in all and per state, for the
   * host's nav pill and the review queues. A receipt the viewer is conflicted on is left out.
   */
  async countAwaitingFinance(viewerId: number): Promise<FinanceCounts> {
    const rows = await receiptRepo.listParties({ orgId: (await getOrg()).id, details: { state: { in: [...FINANCE_ACTION_STATES] } } });
    const lookups = new Map<string, Promise<number[]>>();
    const partiesOf = (r: Parties): Promise<number[]> => {
      const key = `${r.uploadedByUserId}:${r.reimburseePersonId}`;
      const known = lookups.get(key);
      if (known) return known;
      const lookup = conflictedParties(r);
      lookups.set(key, lookup);
      return lookup;
    };
    const conflicted = await Promise.all(rows.map(async (r) => (await partiesOf(r)).includes(viewerId)));
    const byState: Record<string, number> = Object.fromEntries(FINANCE_ACTION_STATES.map((s) => [s, 0]));
    let total = 0;
    rows.forEach((r, i) => {
      if (conflicted[i]) return;
      byState[r.state] += 1;
      total += 1;
    });
    return { total, byState };
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

  /** How many of this person's receipts wait on them, for the host's nav pill. */
  async countAwaitingSubmitter(personId: number): Promise<number> {
    return receiptRepo.count({
      orgId: (await getOrg()).id,
      uploadedByUserId: personId,
      details: { state: { in: [...SUBMITTER_ACTION_STATES] } },
    });
  },

  async listAuditLogs(id: string) {
    const actor = await requireActor();
    await load(id, "finance", actor);
    return receiptRepo.listAuditLogs(id);
  },
};
