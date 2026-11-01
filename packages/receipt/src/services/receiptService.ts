import { isServiceError, ServiceError } from "@checkin/component-kit";
import type { ReceiptState } from "@checkin/receipt-types";
import { z } from "zod";
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import {
  OcrDataSchema,
  purchaseOutcomesSchema,
  reimbursementStatusSchema,
  type OcrData,
  type OcrResult,
  type PaidStatus,
  type PurchaseOutcome,
  type ReceiptPrincipal,
  type ReimbursementAsk,
  type ReimburseeOption,
} from "../contract";
import { sendDonorSync } from "../lib/donor-sync";
import { describeKept, describeReceipts, duplicateGroup as computeGroup, keptReceipts, type DuplicateGroup, type DuplicateMember } from "../lib/duplicateGroup";
import { checkReceiptFile } from "../lib/file-type";
import { insertReceipt, toLineRows, type NewLine } from "../lib/insert";
import { liveIds } from "../lib/livePeople";
import { deleteStoredFiles, readStoredFile } from "../lib/fileStorage";
import { listFilterWhere, type ReceiptListFilter } from "../lib/listFilter";
import { givenUp, pushRecords } from "./catchUp";
import { oweOutcomeNotice, sendOutcomeNotices } from "./outcomeNotices";
import { BODY_COPY_DISCARDED, checkDuplicate, financialReviewReasons, getOrgSettings, pushReceipt, runFullFlow, SUBMITTER_CORRECTION_FIELDS } from "../lib/receipt-flow";
import { listWords, missingDetails } from "../lib/missingDetails";
import { READING_APPLIED } from "../lib/submitterCorrections";
import {
  AddLineItemSchema,
  EditLineItemSchema,
  EditReceiptSchema,
  InKindInputSchema,
  UploadInputSchema,
  type DonorInput,
} from "../lib/schemas";
import { audit, ReceiptStateConflictError, receiptRepo, type Actor, type ReceiptRow, type ReceiptUpdate } from "../repositories/receipt";
import { getOrgId, limits, ports, requireActor } from "../runtime";
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

const EDITABLE: ReadonlySet<string> = new Set(["ocr_failed", "validation_failed", "submitter_review"]);
const IN_SUBMITTER_REVIEW: ReadonlySet<string> = new Set(["submitter_review"]);
const NEEDS_ATTENTION = ["duplicate_flagged", "validation_failed", "submitter_review", "ocr_failed", "flow_error"];

/** The receipt as a submitter sees it: donor names are pii, read by finance only. */

export type SubmitterReceipt = Omit<ReceiptRow, "donorFirstName" | "donorLastName" | "donorCompanyName"> & { rejectionUnacknowledged: boolean };

/** A rejected receipt its uploader has not yet acknowledged; it counts in their pill until they do. */
const rejectionUnacknowledged = (row: Pick<ReceiptRow, "state" | "rejectionAcknowledgedAt">): boolean =>
  row.state === "rejected" && row.rejectionAcknowledgedAt === null;

function toSubmitterView(row: ReceiptRow): SubmitterReceipt {
  const { donorFirstName: _f, donorLastName: _l, donorCompanyName: _c, ...rest } = row;
  return { ...rest, rejectionUnacknowledged: rejectionUnacknowledged(row) };
}

/** X12 answer; null when QuickBooks is off or the read fails, never an error on the page. */
async function paidStatus(owed: ReimbursementAsk[]): Promise<Map<string, PaidStatus> | null> {
  try {
    return reimbursementStatusSchema.parse(await ports().reimbursementStatus.forReceipts(owed));
  } catch (err) {
    console.warn("[receipt] reimbursement status unavailable", err);
    return null;
  }
}

/** Downstream outcome of each finalized receipt; null when it cannot be read, never an error on the page. */
async function purchaseOutcomes(rows: { id: string; state: string }[]): Promise<Map<string, PurchaseOutcome> | null> {
  const ids = rows.filter((r) => r.state === "receipt_finalized").map((r) => r.id);
  if (!ids.length) return new Map();
  try {
    return purchaseOutcomesSchema.parse(await ports().purchaseOutcomes.forReceipts(ids));
  } catch (err) {
    console.warn("[receipt] purchase outcome unavailable", err);
    return null;
  }
}

/** A finalized receipt's outcome as a view field: `{ unavailable: true }` when the read failed. */
function outcomeOf(r: { id: string; state: string }, outcomes: Map<string, PurchaseOutcome> | null): PurchaseOutcome | { unavailable: true } | null {
  if (r.state !== "receipt_finalized") return null;
  if (!outcomes) return { unavailable: true };
  return outcomes.get(r.id) ?? { receiving: null, money: null, gift: null };
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
  const row = await receiptRepo.find(id, await getOrgId());
  if (!row || (access === "submitter" && row.uploadedByUserId !== actor.id)) throw new ServiceError(404, "Receipt not found");
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

const EDIT_STATE_MESSAGE = "Receipt can only be edited in ocr_failed, validation_failed or submitter_review state";

/**
 * Re-check the state under a row lock inside an edit's transaction, so the edit commits before any
 * step that freezes the receipt, or not at all. Delivery happens only from a frozen state.
 * Returns the row as of the lock: audit before-values and gates must come from it, since a row read
 * earlier can predate an edit this one queued behind.
 */
async function lockForEdit(
  tx: Prisma.TransactionClient,
  { id, orgId }: Pick<ReceiptRow, "id" | "orgId">,
  states: ReadonlySet<string>,
  message: string,
): Promise<ReceiptRow> {
  await tx.$queryRaw`SELECT id FROM receipt_details WHERE id = ${id} FOR UPDATE`;
  const locked = await receiptRepo.find(id, orgId, tx);
  if (!locked || !states.has(locked.state)) throw new ServiceError(400, message);
  return locked;
}

/** Move along one machine edge with a compare-and-set on the current state, then audit. */
async function step(
  row: ReceiptRow,
  event: ReceiptEvent,
  expected: ReceiptState,
  set: ReceiptUpdate,
  actor: Actor | null,
  action: string,
  valueAfter: string | null = null,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  try {
    assertLegalTransition(row.state, event);
    assertExpectedState(row.state, event, NEUTRAL_CONTEXT, expected);
    await receiptRepo.update(row.id, { core: set.core, detail: { ...set.detail, state: expected } }, row.state, tx);
  } catch (e) {
    transitionError(e);
  }
  await audit(tx ?? db, row.id, actor, { action, valueAfter });
}

/** An audited 403: the attempt is on the receipt's record even though nothing changed. */
async function refuse(row: ReceiptRow, actor: ReceiptPrincipal, attempted: string, message: string): Promise<never> {
  await audit(db, row.id, actor, { action: "decision_refused", valueAfter: attempted });
  throw new ServiceError(403, message);
}

type Parties = Pick<ReceiptRow, "uploadedByUserId" | "reimburseePersonId">;

/**
 * The uploader, the reimbursee, and everyone in either one's household; null when a party names
 * nobody live, since their household cannot then be known and nobody can be cleared.
 */
async function conflictedParties(row: Parties): Promise<number[] | null> {
  const parties = [row.uploadedByUserId, row.reimburseePersonId].filter((id): id is number => id != null);
  const live = await liveIds(parties);
  const people = parties.flatMap((id) => live.get(id) ?? []);
  if (people.length !== parties.length) return null;
  return [...people, ...(await ports().households.householdOf(people))];
}

async function isConflicted(row: Parties, personId: number): Promise<boolean> {
  return (await conflictedParties(row))?.includes(personId) ?? true;
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
  const parties = await conflictedParties(row);
  if (parties === null) return refuse(row, actor, attempted, "This receipt names someone who is no longer on file, so nobody can be cleared to decide it");
  if (!parties.includes(actor.id)) return;
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

/** Receipt fields that hold what a reimbursement's submitter claimed or is paid. */
const CLAIM_FIELDS: ReadonlySet<string> = new Set(["receiptDate", "currency", "shippingCents", "taxCents", "discountCents", "receiptTotalCents"]);

/**
 * Clears the submitter's confirmation of a reimbursement when anyone but the person whose
 * confirmation it is changes what was claimed or is paid, so the pipeline sends it back to their
 * review. That person is the reimbursee, or the uploader while no reimbursee is known. Audited
 * naming the fields.
 */
async function voidConfirmation(
  tx: Prisma.TransactionClient,
  row: ReceiptRow,
  actor: ReceiptPrincipal,
  fields: string[],
): Promise<void> {
  if (actor.id === (row.reimburseePersonId ?? row.uploadedByUserId) || !row.needsReimbursement || !row.reviewedAt || fields.length === 0) return;
  await tx.receiptDetail.update({ where: { id: row.id }, data: { reviewedAt: null, reviewedByUserId: null, reviewedOnBehalfReason: null } });
  await audit(tx, row.id, actor, {
    action: "submitter_confirmation_voided",
    fieldChanged: fields.join(","),
    valueBefore: row.reviewedAt.toISOString(),
  });
}

/** The host's refusal hook for a typed-in donor (it throws to refuse). "I am the donor" never reaches it: the person deciding the gift is the independent check. */
export type DonorCheck = (donor: { lastName: string }) => Promise<void>;

async function checkTypedDonor(input: { isInKind: boolean; donor?: DonorInput }, checkDonor?: DonorCheck) {
  if (input.isInKind && input.donor && !("self" in input.donor)) await checkDonor?.(input.donor);
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
  const file = await db.receipt.findUniqueOrThrow({ where: { id }, select: { fileBlob: true, fileKey: true, mimeType: true } });
  const bytes = await readStoredFile(file).catch((err: unknown) => {
    console.error(`[receipt] could not read the file of ${id}:`, err);
    return null;
  });
  const raw: OcrResult = bytes ? await ports().ocr.extract(Buffer.from(bytes), file.mimeType) : { success: false, error: "The receipt file could not be read" };
  const parsed = raw.success ? OcrDataSchema.safeParse(raw.data) : null;
  const result: OcrResult = !raw.success
    ? raw
    : parsed?.success
      ? { success: true, data: parsed.data }
      : { success: false, error: "OCR returned invalid receipt data" };
  if (result.success) {
    assertExpectedState("auto_upload", { type: "OCR_SUCCEEDED" }, NEUTRAL_CONTEXT, "uploaded");
    const landed = await db.$transaction(async (tx) => {
      const moved = await tx.receiptDetail.updateMany({
        where: { id, state: "auto_upload" },
        data: { ...ocrDetail(result.data), state: "uploaded", validationNotes: null },
      });
      if (moved.count === 0) {
        await audit(tx, id, actor, { action: "ocr_result_refused", valueAfter: "receipt left OCR while it was being read" });
        return false;
      }
      await tx.receiptLineItem.deleteMany({ where: { receiptId: id } });
      await tx.receipt.update({ where: { id }, data: { lineItems: { create: toLineRows(result.data.lineItems.map(toLine)) } } });
      await audit(tx, id, actor, { action: READING_APPLIED });
      return true;
    });
    if (!landed) throw new ServiceError(409, "Receipt left OCR while it was being read");
    await runFullFlow(id, actor);
  } else {
    await failOcr(id, actor, result.error);
  }
}

async function failOcr(id: string, actor: ReceiptPrincipal, error: string): Promise<void> {
  assertExpectedState("auto_upload", { type: "OCR_FAILED" }, NEUTRAL_CONTEXT, "ocr_failed");
  await db.$transaction(async (tx) => {
    const moved = await tx.receiptDetail.updateMany({
      where: { id, state: "auto_upload" },
      data: { state: "ocr_failed", validationNotes: `OCR failed: ${error}` },
    });
    if (moved.count === 0) return;
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
 * finance assigns. `heldFileKey` names the mail item's object, deleted once the insert has committed.
 */
export async function intakeMailedReceipt(
  actor: ReceiptPrincipal,
  file: Buffer,
  mimeType: string,
  ledger: (tx: Prisma.TransactionClient, receiptId: string) => Promise<unknown>,
  { uploadLimits = true, mailAllowance = true, heldFileKey = null }: { uploadLimits?: boolean; mailAllowance?: boolean; heldFileKey?: string | null } = {},
): Promise<string> {
  const id = await insertReceipt({
    orgId: await getOrgId(),
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
  await deleteStoredFiles([heldFileKey]);
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
  const orgId = await getOrgId();
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

/**
 * The person the uploader names as reimbursee: themselves unless they picked a live adult, or
 * added a non-member, which only finance, operations or the board may do.
 */
async function namedReimbursee(
  actor: ReceiptPrincipal,
  { reimburseePersonId: personId, newReimbursee }: Pick<z.output<typeof UploadInputSchema>, "reimburseePersonId" | "newReimbursee">,
): Promise<ReimburseeOption> {
  if (newReimbursee) {
    if (!actor.addsPeople) throw new ServiceError(403, "Only finance, operations or the board may add someone who is not on file");
    return ports().reimbursees.addNonMemberAdult(newReimbursee.name);
  }
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

/** A reimbursement the person reimbursed confirms, not its uploader: someone else is reimbursed. */
function reimburseeConfirms<R extends Pick<ReceiptRow, "needsReimbursement" | "reimburseePersonId" | "uploadedByUserId">>(row: R): row is R & { reimburseePersonId: number } {
  return row.needsReimbursement && row.reimburseePersonId != null && row.reimburseePersonId !== row.uploadedByUserId;
}

/** A reimbursement waiting for the confirmation that signs it, as the confirming person reads it. */
async function confirmationView(row: ReceiptRow & { reimburseePersonId: number }, onBehalf: boolean, changedFields: string[]) {
  const lines = await receiptRepo.listLineItems(row.id);
  return {
    id: row.id,
    reimburseePersonId: row.reimburseePersonId,
    state: row.state,
    retailer: row.retailer,
    receiptDate: row.receiptDate,
    currency: row.currency,
    shippingCents: row.shippingCents,
    taxCents: row.taxCents,
    discountCents: row.discountCents,
    receiptTotalCents: row.receiptTotalCents,
    onBehalf,
    changedFields,
    lineItems: lines.map((li) => ({
      id: li.id,
      reimburseePersonId: row.reimburseePersonId,
      lineNumber: li.lineNumber,
      description: li.description,
      quantity: li.quantity,
      unitPriceCents: li.unitPriceCents,
      totalPriceCents: li.totalPriceCents,
      isDelayed: li.isDelayed,
    })),
  };
}

/**
 * How `actor` may confirm this reimbursement: as the person reimbursed, or as a Board member on
 * behalf of a reimbursee with no account, if no party to the receipt; else null.
 */
async function confirmerRole(row: Parties, actor: ReceiptPrincipal): Promise<"self" | "on_behalf" | null> {
  if (row.reimburseePersonId == null) return null;
  if (row.reimburseePersonId === actor.id) return "self";
  if (!actor.isBoardMember || (await ports().reimbursees.hasAccount(row.reimburseePersonId))) return null;
  return (await isConflicted(row, actor.id)) ? null : "on_behalf";
}

/**
 * Reimbursements a Board member may confirm on behalf of a reimbursee with no account, before
 * finance and once their expense exists, with what finance changed; none the member is party to,
 * and none whose expense refuses them the submitter seat.
 */
async function onBehalfConfirmations(actor: ReceiptPrincipal): Promise<{ rows: Array<ReceiptRow & { reimburseePersonId: number }>; changed: Map<string, string[]> }> {
  if (!actor.isBoardMember) return { rows: [], changed: new Map() };
  const orgId = await getOrgId();
  const awaited = await awaitedConfirmations();
  const reimburseeOnExpense = new Map(awaited.map((a) => [a.receiptId, a.reimburseePersonId]));
  const inReview = await receiptRepo.list({ orgId, needsReimbursement: true, reimburseePersonId: { not: null }, details: { state: "submitter_review" } });
  const sent = await receiptRepo.list({ orgId, id: { in: awaited.map((a) => a.receiptId) } });
  // Once the expense exists, its reimbursee is the one confirming: finance may have named them there.
  const candidates = [
    ...inReview.map((r) => ({ ...r, reimburseePersonId: r.reimburseePersonId! })),
    ...sent.map((r) => ({ ...r, reimburseePersonId: reimburseeOnExpense.get(r.id)! })),
  ];
  const onBehalf: Array<ReceiptRow & { reimburseePersonId: number }> = [];
  for (const r of candidates) if ((await confirmerRole(r, actor)) === "on_behalf") onBehalf.push(r);
  const sentIds = new Set(sent.map((r) => r.id));
  const signable = new Set(await ports().submitterConfirmations.confirmable(onBehalf.filter((r) => sentIds.has(r.id)).map((r) => r.id), actor.id));
  const rows = onBehalf.filter((r) => !sentIds.has(r.id) || signable.has(r.id));
  return { rows, changed: new Map(awaited.map((a) => [a.receiptId, a.changedFields])) };
}

/** What waits on expense, with the live reimbursee; `storedReimburseeId` is the id expense knows them by. */
async function awaitedConfirmations() {
  const awaited = await ports().submitterConfirmations.awaiting();
  const live = await liveIds(awaited.map((a) => a.reimburseePersonId));
  return awaited.map((a) => ({ ...a, storedReimburseeId: a.reimburseePersonId, reimburseePersonId: live.get(a.reimburseePersonId) ?? a.reimburseePersonId }));
}

/** Reimbursements waiting for this person's confirmation, before finance and once their expense exists. */
async function awaitingConfirmation(personId: number): Promise<{ inReview: ReceiptRow[]; sent: Map<string, string[]> }> {
  const orgId = await getOrgId();
  const ids = await ports().personIds.storedIdsOf(personId);
  const [inReview, awaited] = await Promise.all([
    receiptRepo.list({ orgId, needsReimbursement: true, reimburseePersonId: { in: ids }, uploadedByUserId: { notIn: ids }, details: { state: "submitter_review" } }),
    awaitedConfirmations(),
  ]);
  return { inReview, sent: new Map(awaited.filter((a) => a.reimburseePersonId === personId).map((a) => [a.receiptId, a.changedFields])) };
}

async function runFlowLogged(id: string, actor: Actor | null): Promise<void> {
  await runFullFlow(id, actor).catch((err: unknown) => {
    console.error(`[receipt] pipeline failed for ${id}:`, err);
  });
}

/** Finance refuses an open receipt with a reason, recorded as its finance review, and owes its outcome email. */
async function rejectAsFinance(row: ReceiptRow, note: string, actor: ReceiptPrincipal, tx: Prisma.TransactionClient): Promise<void> {
  const reasons = row.state === "financial_review" ? await financialReviewReasons(row, await getOrgSettings(row.orgId)) : [];
  const set = { core: recordFinanceReview("rejected", row, reasons, actor, note, new Date()), detail: { validationNotes: note } };
  await step(row, { type: "REJECT" }, "rejected", set, actor, "reject_financial", note, tx);
  await oweOutcomeNotice(tx, row.orgId, row.id, "receipt_rejected");
}

// ── Duplicate groups (2516_RECEIPT_DUPLICATES.md §5.5, §6) ─────────────────────

const ENDED: ReadonlySet<string> = new Set(["receipt_finalized", "rejected", "discarded"]);

type PairKind = "different" | "copy_of";

const livePairIds = (members: DuplicateMember[]) => members.filter((m) => m.state !== "discarded").map((m) => m.id);
const pairOf = (a: string, b: string) => (a < b ? { receiptId: a, otherReceiptId: b } : { receiptId: b, otherReceiptId: a });

/**
 * Records one pair decision, replacing any earlier one for the pair. The pair table keeps only
 * the latest, so each decision is also audited on both receipts.
 */
async function decidePair(tx: Prisma.TransactionClient, orgId: string, a: string, b: string, kind: PairKind, actor: ReceiptPrincipal, copyReceiptId: string | null = null): Promise<void> {
  const pair = pairOf(a, b);
  const decision = { kind, copyReceiptId, decidedByUserId: actor.id, decidedAt: new Date() };
  await tx.receiptPairDecision.upsert({ where: { receipt_pair_decisions_pair_unique: pair }, create: { orgId, ...pair, ...decision }, update: decision });
  const action = kind === "different" ? "duplicate_pair_different" : "duplicate_pair_copy_of";
  await audit(tx, a, actor, { action, valueAfter: b });
  await audit(tx, b, actor, { action, valueAfter: a });
}

/** Row locks on the receipts a decision covers, in id order so two deciders never deadlock. */
async function lockReceipts(tx: Prisma.TransactionClient, orgId: string, ids: string[]): Promise<void> {
  await tx.$queryRaw`SELECT id FROM receipt_details WHERE org_id = ${orgId} AND id = ANY(${[...new Set(ids)].sort()}) ORDER BY id FOR UPDATE`;
}

/** Nobody decides a group in which they are conflicted on any member, the viewed receipt first (§6.1). */
async function refuseConflictedMember(row: ReceiptRow, memberIds: string[], actor: ReceiptPrincipal, attempted: string): Promise<void> {
  await refuseSelfDecision(row, actor, attempted);
  for (const member of await receiptRepo.list({ orgId: row.orgId, id: { in: memberIds.filter((m) => m !== row.id) } })) {
    await refuseSelfDecision(member, actor, attempted);
  }
}

/** The 409 for a group that changed after the panel was drawn, naming the change. */
async function staleGroup(tx: Prisma.TransactionClient, shown: string[], current: string[]): Promise<ServiceError> {
  const added = current.filter((id) => !shown.includes(id));
  const gone = shown.filter((id) => !current.includes(id));
  const named = await describeReceipts(tx, [...added, ...gone]);
  const list = (ids: string[]) => ids.map((id) => named.get(id) ?? "a receipt").join("; ");
  if (added.length > 0) return new ServiceError(409, `A new possible copy arrived after you opened this: ${list(added)}`);
  if (gone.length > 0) return new ServiceError(409, `This group changed after you opened it: ${list(gone)} left it`);
  return new ServiceError(409, "This group was decided after you opened it");
}

const DECIDED_SINCE = "This receipt was decided after you opened it";

/**
 * Re-runs each held receipt left with no undecided match (§6.4); one still matching stays held.
 * A receipt another request moved meanwhile is left to that request. A null actor is a system
 * re-check, for a change that was not a decision on the group.
 */
async function recheck(orgId: string, ids: string[], actor: Actor | null): Promise<void> {
  for (const id of ids) {
    const row = await receiptRepo.find(id, orgId);
    if (row?.state !== "duplicate_flagged" || (await checkDuplicate(row))) continue;
    try {
      await step(row, { type: "DUPLICATE_CLEARED" }, "uploaded", { detail: { duplicateFlagClearedAt: new Date() } }, actor, "duplicate_cleared");
    } catch (e) {
      if (isServiceError(e) && e.status === 409) continue;
      throw e;
    }
    await runFlowLogged(id, actor);
  }
}

/** The ids of every member of a receipt's group, to re-check once it changes. */
async function memberIds(orgId: string, id: string): Promise<string[]> {
  return ((await computeGroup(orgId, id))?.members ?? []).map((m) => m.id).filter((m) => m !== id);
}

/**
 * A decision that settles the whole group (§5.5). The group is recomputed under row locks in the
 * transaction and must still be exactly the live members the panel showed, with the viewed
 * receipt still open; otherwise nothing is written and the answer is 409. Every member is
 * re-checked once it commits. A viewed receipt still held after the re-check answers 409 naming
 * what holds it, so a success never leaves it held.
 */
async function decideGroup(
  id: string,
  shownIds: string[],
  attempted: string,
  done: string,
  decide: (tx: Prisma.TransactionClient, viewed: ReceiptRow, members: DuplicateMember[], actor: ReceiptPrincipal) => Promise<void>,
) {
  const shown = parse(z.array(z.string().min(1)).min(1), shownIds);
  const actor = await requireActor();
  const row = await loadForChange(id, "finance", actor);
  const covered = [...new Set([...shown, ...(await memberIds(row.orgId, id))])].filter((m) => m !== id);
  await refuseConflictedMember(row, covered, actor, attempted);
  const decided = await db.$transaction(async (tx) => {
    await lockReceipts(tx, row.orgId, [id, ...covered]);
    const group = await computeGroup(row.orgId, id, tx);
    const viewed = group?.members.find((m) => m.id === id);
    if (!group || !viewed || ENDED.has(viewed.state)) throw new ServiceError(409, DECIDED_SINCE);
    const live = livePairIds(group.members);
    if (live.length !== new Set(shown).size || !live.every((m) => shown.includes(m))) throw await staleGroup(tx, shown, live);
    await decide(tx, row, group.members, actor);
    return live;
  });
  await sendOutcomeNotices(decided);
  await recheck(row.orgId, decided, actor);
  const after = await load(id, "finance", actor);
  const holder = after.state === "duplicate_flagged" ? await checkDuplicate(after) : null;
  if (holder) {
    const named = (await describeReceipts(db, [holder])).get(holder) ?? "another receipt";
    throw new ServiceError(409, `${done}, but this receipt is still held beside ${named}, which arrived or changed meanwhile`);
  }
  return after;
}

export const receiptService = {
  /**
   * Upload a receipt. With `details` it is manual: insert at `uploaded` and run the pipeline.
   * Without, it is auto: insert at `auto_upload` and read it with OCR in this request.
   */
  async upload(file: Buffer, declaredType: string, rawInput: unknown, checkDonor?: DonorCheck) {
    const actor = await requireActor();
    const input = parse(UploadInputSchema, rawInput);
    const check = checkReceiptFile(file, declaredType);
    if (!check.ok) throw new ServiceError(400, check.error);
    if (input.needsReimbursement && !actor.isAdult) throw new ServiceError(400, "Reimbursement is not available for this account");
    await checkTypedDonor(input, checkDonor);

    const reimbursee = input.needsReimbursement ? await namedReimbursee(actor, input) : null;
    const reimbursement = reimbursee
      ? { needsReimbursement: true, reimbursementFor: reimbursee.name, reimburseePersonId: reimbursee.id }
      : {};
    const inKind = input.isInKind && input.donor ? { isInKind: true, donorSync: "pending", ...donorNames(input.donor, actor) } : {};
    const d = input.details;
    if (!d) await reserveOcrCall(actor);

    const id = await insertReceipt({
      orgId: await getOrgId(),
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
    if (!EDITABLE.has(row.state)) throw new ServiceError(400, EDIT_STATE_MESSAGE);
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

    await db.$transaction(async (tx) => {
      const locked = await lockForEdit(tx, row, EDITABLE, EDIT_STATE_MESSAGE);
      const changed = Object.entries(next).filter(
        ([k, v]) => v !== undefined && String(locked[k as keyof typeof next]) !== String(v),
      );
      if (changed.length === 0) return;
      // A submitter's tax or date correction needs a fresh finance review.
      const reopensReview = asSubmitter && changed.some(([field]) => SUBMITTER_CORRECTION_FIELDS.includes(field));
      await tx.receiptDetail.update({ where: { id }, data: reopensReview ? { ...next, approvedAt: null } : next });
      if (reopensReview) await tx.receiptFinanceReview.deleteMany({ where: { receiptId: id } });
      await voidConfirmation(tx, locked, actor, changed.map(([field]) => field).filter((f) => CLAIM_FIELDS.has(f)));
      for (const [field, after] of changed) {
        await audit(tx, id, actor, {
          action: "field_edit",
          fieldChanged: field,
          valueBefore: String(locked[field as keyof typeof next]),
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
    const stateMessage = "Can only add lines in ocr_failed, validation_failed or submitter_review state";
    if (!EDITABLE.has(row.state)) throw new ServiceError(400, stateMessage);
    await writeAccess(row, access, actor, "add line");
    return db.$transaction(async (tx) => {
      const locked = await lockForEdit(tx, row, EDITABLE, stateMessage);
      const count = await tx.receiptLineItem.count({ where: { receiptId: id } });
      if (count >= 200) throw new ServiceError(400, "At most 200 line items");
      const last = await tx.receiptLineItem.aggregate({ where: { receiptId: id }, _max: { lineNumber: true } });
      const [data] = toLineRows([{ ...toLine(line), lineNumber: (last._max.lineNumber ?? 0) + 1 }]);
      const created = await tx.receiptLineItem.create({ data: { ...data, receiptId: id } });
      await audit(tx, id, actor, { action: "line_added", lineItemId: created.id });
      await voidConfirmation(tx, locked, actor, ["lineItems"]);
      return created;
    });
  },

  async editLine(id: string, access: Access, lineItemId: number, rawLine: unknown) {
    const actor = await requireActor();
    const edit = parse(EditLineItemSchema, rawLine);
    const row = await loadForChange(id, access, actor);
    const stateMessage = "Line items can only be edited in ocr_failed, validation_failed or submitter_review state";
    if (!EDITABLE.has(row.state)) throw new ServiceError(400, stateMessage);
    await writeAccess(row, access, actor, "edit line");

    return db.$transaction(async (tx) => {
      const locked = await lockForEdit(tx, row, EDITABLE, stateMessage);
      const li = await tx.receiptLineItem.findFirst({ where: { id: lineItemId, receiptId: id } });
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

      const edited = fields.filter((f) => f.after !== undefined && String(f.before) !== String(f.after));
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
      for (const f of edited) {
        await audit(tx, id, actor, {
          action: "field_edit",
          fieldChanged: f.field,
          valueBefore: f.before === null ? null : String(f.before),
          valueAfter: f.after === null ? null : String(f.after),
          lineItemId,
        });
      }
      if (edited.length > 0) await voidConfirmation(tx, locked, actor, ["lineItems"]);
      return updated;
    });
  },

  async deleteLine(id: string, access: Access, lineItemId: number): Promise<void> {
    const actor = await requireActor();
    const row = await loadForChange(id, access, actor);
    const stateMessage = "Can only delete lines in ocr_failed, validation_failed or submitter_review state";
    if (!EDITABLE.has(row.state)) throw new ServiceError(400, stateMessage);
    await writeAccess(row, access, actor, "delete line");
    await db.$transaction(async (tx) => {
      const locked = await lockForEdit(tx, row, EDITABLE, stateMessage);
      const li = await tx.receiptLineItem.findFirst({ where: { id: lineItemId, receiptId: id } });
      if (!li) throw new ServiceError(404, "Line item not found");
      await audit(tx, id, actor, { action: "line_deleted", lineItemId });
      await tx.receiptLineItem.delete({ where: { id: lineItemId } });
      await voidConfirmation(tx, locked, actor, ["lineItems"]);
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

  /**
   * The uploader withdraws their own receipt; anyone else who can see it is refused. The rest of
   * its duplicate group is re-checked.
   */
  async discard(id: string, access: Access) {
    const actor = await requireActor();
    const row = await loadForChange(id, access, actor);
    if (row.uploadedByUserId !== actor.id) await refuse(row, actor, "discard", "Only the person who uploaded a receipt can discard it");
    const members = await memberIds(row.orgId, id);
    await step(row, { type: "DISCARD" }, "discarded", {}, actor, "discarded");
    await recheck(row.orgId, members, null);
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
    await db.$transaction((tx) => rejectAsFinance(row, note, actor, tx));
    await sendOutcomeNotices([id]);
    for (const flagged of flaggedAgainst) await audit(db, flagged.id, actor, { action: "suspected_original_rejected", valueAfter: row.id });
    return load(id, "finance", actor);
  },

  /**
   * Not this one (§5.3): the viewed receipt and one match are different purchases. A newcomer to
   * the group doesn't refuse it; the match having left the group, or the viewed receipt having
   * been decided, does (409). Answers with the fresh group.
   */
  async notThisOne(id: string, otherId: string): Promise<DuplicateGroup> {
    const actor = await requireActor();
    const row = await loadForChange(id, "finance", actor);
    const members = await memberIds(row.orgId, id);
    await refuseConflictedMember(row, [...new Set([...members, otherId])], actor, "not this one");
    await db.$transaction(async (tx) => {
      await lockReceipts(tx, row.orgId, [id, otherId]);
      const group = await computeGroup(row.orgId, id, tx);
      const viewed = group?.members.find((m) => m.id === id);
      if (!group || !viewed || ENDED.has(viewed.state)) throw new ServiceError(409, DECIDED_SINCE);
      if (otherId === id || !livePairIds(group.members).includes(otherId)) {
        throw new ServiceError(409, "That receipt is no longer a match here; the group changed after you opened it");
      }
      await decidePair(tx, row.orgId, id, otherId, "different", actor);
    });
    await recheck(row.orgId, [id, ...members], actor);
    return receiptService.duplicateGroup(id);
  },

  /**
   * Undo of Not this one: deletes that pair decision while the viewed receipt is still held (§5.3).
   * Refused once the dismissal released the match from its own hold, since the match may have
   * finalized on it.
   */
  async undoNotThisOne(id: string, otherId: string): Promise<DuplicateGroup> {
    const actor = await requireActor();
    const row = await loadForChange(id, "finance", actor);
    if (row.state !== "duplicate_flagged") throw new ServiceError(409, "This receipt has moved on, so the decision stands");
    await refuseConflictedMember(row, [...new Set([...(await memberIds(row.orgId, id)), otherId])], actor, "undo not this one");
    await db.$transaction(async (tx) => {
      await lockReceipts(tx, row.orgId, [id, otherId]);
      const current = await tx.receiptDetail.findUnique({ where: { id }, select: { state: true } });
      if (current?.state !== "duplicate_flagged") throw new ServiceError(409, "This receipt has moved on, so the decision stands");
      const decision = await tx.receiptPairDecision.findFirst({ where: { ...pairOf(id, otherId), kind: "different" } });
      if (!decision) throw new ServiceError(409, "That match is not dismissed; the group changed after you opened it");
      const released = await tx.receiptAuditLog.findFirst({ where: { receiptId: otherId, action: "duplicate_cleared", changedAt: { gte: decision.decidedAt } } });
      if (released) throw new ServiceError(409, "That match left its hold when it was dismissed, so the decision stands");
      await tx.receiptPairDecision.delete({ where: { id: decision.id } });
      await audit(tx, id, actor, { action: "duplicate_pair_undone", valueAfter: otherId });
      await audit(tx, otherId, actor, { action: "duplicate_pair_undone", valueAfter: id });
    });
    return receiptService.duplicateGroup(id);
  },

  /**
   * Different purchases (§6.2): every pair of the group's live members, as shown on the panel,
   * is recorded as different purchases, and every held member re-runs the pipeline.
   */
  async differentPurchases(id: string, shownIds: string[]) {
    return decideGroup(id, shownIds, "different purchases", "Recorded as different purchases", async (tx, viewed, members, actor) => {
      const ids = livePairIds(members);
      const already = await tx.receiptPairDecision.findMany({
        where: { kind: "different", receiptId: { in: ids }, otherReceiptId: { in: ids } },
        select: { receiptId: true, otherReceiptId: true },
      });
      const done = new Set(already.map((p) => `${p.receiptId}:${p.otherReceiptId}`));
      for (const [i, a] of ids.entries()) {
        for (const b of ids.slice(i + 1)) {
          const pair = pairOf(a, b);
          if (!done.has(`${pair.receiptId}:${pair.otherReceiptId}`)) await decidePair(tx, viewed.orgId, a, b, "different", actor);
        }
      }
    });
  },

  /**
   * Keep this one (§6.2): rejects every other open member as a copy of the viewed receipt, and
   * records each as a copy of it. A member already rejected keeps its state and is recorded as a
   * copy too, so the kept receipt leaves the hold. Beside a finalized member it is refused: that
   * copy is the one to keep, and this receipt is rejected instead.
   */
  async keepThisOne(id: string, shownIds: string[]) {
    return decideGroup(id, shownIds, "keep this one", "The other copies are rejected as copies of this one", async (tx, kept, members, actor) => {
      if (members.some((m) => m.id !== kept.id && m.state === "receipt_finalized")) {
        throw new ServiceError(409, "A finalized copy exists: reject this receipt as a copy of it instead");
      }
      const ids = members.map((m) => m.id);
      const uploads = [...(await keptReceipts(tx, ids)).values()].map((r) => r.uploadedAt);
      const note = `Copy of ${describeKept({ retailer: kept.retailer, uploadedAt: kept.uploadedAt }, uploads)}`;
      const open = members.filter((m) => m.id !== kept.id && !ENDED.has(m.state)).map((m) => m.id);
      for (const copy of await receiptRepo.list({ orgId: kept.orgId, id: { in: open } })) {
        await decidePair(tx, kept.orgId, kept.id, copy.id, "copy_of", actor, copy.id);
        await rejectAsFinance(copy, note, actor, tx);
      }
      for (const rejected of members.filter((m) => m.state === "rejected")) {
        await decidePair(tx, kept.orgId, kept.id, rejected.id, "copy_of", actor, rejected.id);
      }
    });
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
    await step(row, { type: "RESUBMIT" }, "uploaded", { detail: { validationNotes: null } }, actor, "resubmitted");
    await runFullFlow(id, actor);
    return load(id, access, actor);
  },

  /** The uploader confirms the receipt as read. A reimbursement for someone else is the reimbursee's to confirm. */
  async submitterConfirm(id: string) {
    const actor = await requireActor();
    const row = await loadForChange(id, "submitter", actor);
    if (row.needsReimbursement && !row.reimbursementFor?.trim()) {
      throw new ServiceError(400, "reimbursementFor is required when needsReimbursement is set");
    }
    const missing = missingDetails(row);
    if (missing.length > 0) throw new ServiceError(400, `Fill in the ${listWords(missing)} before confirming this receipt`);
    if (reimburseeConfirms(row)) throw new ServiceError(403, "The person reimbursed confirms this receipt");
    await step(row, { type: "SUBMITTER_CONFIRMED" }, "uploaded", { detail: { reviewedAt: new Date(), reviewedByUserId: actor.id, validationNotes: null } }, actor, "submitter_review_confirmed");
    await runFullFlow(id, actor);
    return toSubmitterView(await load(id, "submitter", actor));
  },

  /**
   * Reimbursements waiting for the caller's confirmation: as the person reimbursed, and, for a
   * Board member, those whose reimbursee has no account and that the caller is no party to.
   */
  async listConfirmations() {
    const actor = await requireActor();
    const mine = await awaitingConfirmation(actor.id);
    const orgId = await getOrgId();
    const sent = await receiptRepo.list({ orgId, id: { in: [...mine.sent.keys()] } });
    const views = [
      ...mine.inReview.filter(reimburseeConfirms).map((r) => confirmationView(r, false, [])),
      ...sent.map((r) => confirmationView({ ...r, reimburseePersonId: actor.id }, false, mine.sent.get(r.id) ?? [])),
    ];
    const onBehalf = await onBehalfConfirmations(actor);
    views.push(...onBehalf.rows.map((r) => confirmationView(r, true, onBehalf.changed.get(r.id) ?? [])));
    return Promise.all(views);
  },

  /**
   * The person reimbursed confirms the receipt as read, or a Board member does on behalf of a
   * reimbursee with no account, giving the reason. Before finance it moves the receipt on from
   * submitter review; once the expense exists it signs the lines still waiting there.
   */
  async confirmAsReimbursee(id: string, rawReason?: string | null) {
    const actor = await requireActor();
    const row = await receiptRepo.find(id, await getOrgId());
    if (!row || !row.needsReimbursement) throw new ServiceError(404, "Receipt not found");
    // Once the expense exists, its reimbursee is the one confirming: finance may have named them there.
    const onExpense = row.pushedAt ? (await awaitedConfirmations()).find((a) => a.receiptId === id) : undefined;
    const reimbursee = row.pushedAt ? onExpense?.reimburseePersonId : row.reimburseePersonId;
    if (reimbursee == null) throw new ServiceError(409, "This receipt is not waiting for a confirmation");
    const role = await confirmerRole({ uploadedByUserId: row.uploadedByUserId, reimburseePersonId: reimbursee }, actor);
    if (!role) throw new ServiceError(403, "Only the person reimbursed, or a Board member on behalf of someone with no account, confirms this receipt");
    const reason = role === "on_behalf" ? rawReason?.trim() || null : null;
    if (role === "on_behalf" && !reason) throw new ServiceError(400, "A Board member confirming on the reimbursee's behalf gives the reason");
    const onBehalf = reason ? `on behalf of ${reimbursee}: ${reason}` : null;

    if (onExpense) {
      if (!(await ports().submitterConfirmations.confirm(id, onExpense.storedReimburseeId, actor, reason))) {
        throw new ServiceError(409, "This receipt is not waiting for a confirmation");
      }
      await audit(db, id, actor, { action: "submitter_reconfirmed", valueAfter: onBehalf });
    } else {
      if (row.state !== "submitter_review") throw new ServiceError(409, "This receipt is not waiting for a confirmation");
      const missing = missingDetails(row);
      if (missing.length > 0) throw new ServiceError(400, `Fill in the ${listWords(missing)} before confirming this receipt`);
      const detail = { reviewedAt: new Date(), reviewedByUserId: actor.id, reviewedOnBehalfReason: reason, validationNotes: null };
      await step(row, { type: "SUBMITTER_CONFIRMED" }, "uploaded", { detail }, actor, "submitter_review_confirmed", onBehalf);
      await runFullFlow(id, actor);
    }
    const after = (await receiptRepo.find(id, row.orgId))!;
    return confirmationView({ ...after, reimburseePersonId: reimbursee }, role === "on_behalf", []);
  },

  async submitterDiscard(id: string) {
    const actor = await requireActor();
    const row = await loadForChange(id, "submitter", actor);
    const members = await memberIds(row.orgId, id);
    await step(row, { type: "SUBMITTER_DISCARDED" }, "discarded", {}, actor, "discarded");
    await recheck(row.orgId, members, null);
    return toSubmitterView(await load(id, "submitter", actor));
  },

  /** "I paid for this myself": ticking it names the uploader as reimbursee. */
  async setReimbursement(id: string, rawInput: unknown) {
    const actor = await requireActor();
    const { needsReimbursement } = parse(z.object({ needsReimbursement: z.boolean() }).strict(), rawInput);
    const row = await loadForChange(id, "submitter", actor);
    const stateMessage = "Receipt is not in submitter_review state";
    if (row.state !== "submitter_review") throw new ServiceError(400, stateMessage);
    if (needsReimbursement && !actor.isAdult) throw new ServiceError(400, "Reimbursement is not available for this account");

    await db.$transaction(async (tx) => {
      const locked = await lockForEdit(tx, row, IN_SUBMITTER_REVIEW, stateMessage);
      if (needsReimbursement && locked.isInKind) throw new ServiceError(400, "An in-kind receipt cannot be reimbursed");
      await tx.receipt.update({
        where: { id },
        data: needsReimbursement
          ? { needsReimbursement, reimbursementFor: actor.name ?? `${actor.firstName} ${actor.lastName}`, reimburseePersonId: actor.id }
          : { needsReimbursement, reimbursementFor: null, reimburseePersonId: null },
      });
      await audit(tx, id, actor, {
        action: "reimbursement_updated",
        fieldChanged: "needsReimbursement",
        valueBefore: String(locked.needsReimbursement),
        valueAfter: String(needsReimbursement),
      });
    });
    return toSubmitterView(await load(id, "submitter", actor));
  },

  /** Set or clear the in-kind mark and its donor, then tell donations (X13). */
  async setInKind(id: string, rawInput: unknown, checkDonor?: DonorCheck) {
    const actor = await requireActor();
    const input = parse(InKindInputSchema, rawInput);
    const row = await loadForChange(id, "submitter", actor);
    if (!EDITABLE.has(row.state)) throw new ServiceError(400, EDIT_STATE_MESSAGE);
    await checkTypedDonor(input, checkDonor);

    const donor = input.isInKind && input.donor
      ? donorNames(input.donor, actor)
      : { donorFirstName: null, donorLastName: null, donorCompanyName: null };
    const updated = await db.$transaction(async (tx) => {
      const locked = await lockForEdit(tx, row, EDITABLE, EDIT_STATE_MESSAGE);
      if (input.isInKind && locked.needsReimbursement) throw new ServiceError(400, "An in-kind receipt cannot be reimbursed");
      if (input.isInKind && locked.qbTxnId) throw new ServiceError(400, "This receipt is already in QuickBooks, so it can't be marked as a donation");
      if (!input.isInKind && locked.donorSync === "none") return false;
      await tx.receipt.update({ where: { id }, data: { isInKind: input.isInKind, donorSync: "pending", donorSyncSeq: { increment: 1 }, ...donor } });
      await audit(tx, id, actor, {
        action: "in_kind_updated",
        fieldChanged: "isInKind",
        valueBefore: String(locked.isInKind),
        valueAfter: String(input.isInKind),
      });
      return true;
    });
    if (updated) await sendDonorSync(id, actor);
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
    const group = await computeGroup(await getOrgId(), id);
    if (!group) throw new ServiceError(404, "Receipt not found");
    return group;
  },

  async get(id: string, access: Access) {
    const actor = await requireActor();
    const row = await load(id, access, actor);
    const lineItems = await receiptRepo.listLineItems(id);
    const reasons = row.state === "financial_review" ? await financialReviewReasons(row, await getOrgSettings(row.orgId)) : [];
    const receipt = access === "finance" ? { ...row, rejectionUnacknowledged: rejectionUnacknowledged(row) } : toSubmitterView(row);
    const purchaseOutcome = outcomeOf(row, await purchaseOutcomes([row]));
    return { ...receipt, lineItems, financialReviewReasons: reasons, purchaseOutcome };
  },

  /**
   * The stored bytes for the file route, with the owner column its scope check reads. Every
   * read is audited; the audit holds no bytes.
   */
  async getFile(id: string, access: Access): Promise<{ fileBlob: Uint8Array; mimeType: string; uploadedByUserId: number }> {
    const actor = await requireActor();
    const row = await load(id, access, actor);
    const file = await db.receipt.findUniqueOrThrow({ where: { id }, select: { fileBlob: true, fileKey: true, mimeType: true } });
    const fileBlob = await readStoredFile(file);
    if (!fileBlob) throw new ServiceError(404, "Receipt file not found");
    await audit(db, id, actor, { action: "file_viewed" });
    return { fileBlob, mimeType: file.mimeType, uploadedByUserId: row.uploadedByUserId };
  },

  /**
   * "My receipts": the caller's own receipts, each owed one with its QuickBooks paid status, or
   * `statusUnavailable` when that status cannot be read. Complete = discarded, rejected and
   * acknowledged, or finalized and either not owed or shown paid.
   */
  async listMine(opts: { hideCompleted?: boolean } = {}) {
    const actor = await requireActor();
    const rows = await receiptRepo.list({ orgId: await getOrgId(), uploadedByUserId: { in: await ports().personIds.storedIdsOf(actor.id) } });
    const owed = rows.filter((r) => r.needsReimbursement).map((r) => ({ receiptId: r.id, qbEntity: r.qbEntity, qbTxnId: r.qbTxnId }));
    const [paid, outcomes] = await Promise.all([owed.length ? paidStatus(owed) : new Map<string, PaidStatus>(), purchaseOutcomes(rows)]);

    const list = rows.map((r) => {
      const paidOn = r.needsReimbursement ? (paid?.get(r.id)?.paidOn ?? null) : null;
      const complete =
        r.state === "discarded" ||
        (r.state === "rejected" && !rejectionUnacknowledged(r)) ||
        (r.state === "receipt_finalized" && (!r.needsReimbursement || paidOn !== null));
      const reimbursement = r.needsReimbursement ? (paid && !paid.get(r.id)?.statusUnavailable ? { paidOn } : { paidOn, statusUnavailable: true }) : null;
      return { ...toSubmitterView(r), reimbursement, complete, purchaseOutcome: outcomeOf(r, outcomes) };
    });
    return opts.hideCompleted ? list.filter((r) => !r.complete) : list;
  },

  /**
   * Reimbursements naming the caller that someone else uploaded, once finance has settled the
   * receipt: finalized with its purchase outcome, or rejected with finance's reason. No uploader,
   * donor or file field.
   */
  async listReimbursedToMe() {
    const actor = await requireActor();
    const ids = await ports().personIds.storedIdsOf(actor.id);
    const rows = await receiptRepo.list({
      orgId: await getOrgId(),
      needsReimbursement: true,
      reimburseePersonId: { in: ids },
      uploadedByUserId: { notIn: ids },
      details: { state: { in: ["receipt_finalized", "rejected"] } },
    });
    const owed = rows.map((r) => ({ receiptId: r.id, qbEntity: r.qbEntity, qbTxnId: r.qbTxnId }));
    const [paid, outcomes] = await Promise.all([owed.length ? paidStatus(owed) : new Map<string, PaidStatus>(), purchaseOutcomes(rows)]);
    return rows.map((r) => ({
      id: r.id,
      reimburseePersonId: actor.id,
      state: r.state,
      retailer: r.retailer,
      receiptDate: r.receiptDate,
      currency: r.currency,
      receiptTotalCents: r.receiptTotalCents,
      rejectionReason: r.state === "rejected" ? r.validationNotes : null,
      reimbursement: paid && !paid.get(r.id)?.statusUnavailable ? { paidOn: paid.get(r.id)?.paidOn ?? null } : { paidOn: null, statusUnavailable: true },
      purchaseOutcome: outcomeOf(r, outcomes),
    }));
  },

  async listForOrg() {
    await requireActor();
    return receiptRepo.list({ orgId: await getOrgId() });
  },

  /**
   * The org's receipts narrowed by `filter`; an unknown state matches no rows. A finalized
   * receipt not yet delivered to receiving carries its push record.
   */
  async list(filter: ReceiptListFilter) {
    await requireActor();
    const orgId = await getOrgId();
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
    const orgId = await getOrgId();
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
   * How many of the org's receipts wait on this FINANCE viewer, for the host's nav pill and the
   * review queues. The total also holds undelivered receipts catch-up gave up on, which have no
   * queue state of their own. A receipt the viewer is conflicted on is left out.
   */
  async countAwaitingFinance(viewerId: number): Promise<FinanceCounts> {
    const orgId = await getOrgId();
    const [queued, undelivered] = await Promise.all([
      receiptRepo.listParties({ orgId, details: { state: { in: [...FINANCE_ACTION_STATES] } } }),
      receiptRepo.listParties({ orgId, pushedAt: null, details: { state: "receipt_finalized" } }),
    ]);
    const [stopped, household] = await Promise.all([
      givenUp(orgId, undelivered.map((r) => r.id)),
      ports().households.householdOf([viewerId]),
    ]);
    const conflicted = new Set([viewerId, ...household]);
    const rows = [...queued, ...undelivered.filter((r) => stopped.has(r.id))];
    const byState: Record<string, number> = Object.fromEntries(FINANCE_ACTION_STATES.map((s) => [s, 0]));
    let total = 0;
    rows.forEach((r) => {
      if (conflicted.has(r.uploadedByUserId) || (r.reimburseePersonId != null && conflicted.has(r.reimburseePersonId))) return;
      if (r.state in byState) byState[r.state] += 1;
      total += 1;
    });
    return { total, byState };
  },

  async listNeedsAttention(access: Access) {
    const actor = await requireActor();
    const orgId = await getOrgId();
    const rows = await receiptRepo.list({
      orgId,
      ...(access === "submitter" ? { uploadedByUserId: { in: await ports().personIds.storedIdsOf(actor.id) } } : {}),
      details: { state: { in: NEEDS_ATTENTION } },
    });
    if (access !== "finance") return rows.map(toSubmitterView);
    const undelivered = await receiptRepo.list({ orgId, pushedAt: null, details: { state: "receipt_finalized" } });
    const records = await pushRecords(orgId, undelivered.map((r) => r.id));
    const stopped = undelivered.filter((r) => records.get(r.id)?.pushGivenUp);
    const conflicted = await Promise.all(stopped.map((r) => isConflicted(r, actor.id)));
    return [...rows, ...stopped.flatMap((r, i) => (conflicted[i] ? [] : [{ ...r, ...records.get(r.id) }]))];
  },

  /**
   * How many of this person's receipts wait on them, for the host's nav pill: those in a state that
   * waits on the uploader, less a reimbursement for someone else, which its reimbursee confirms,
   * plus each rejected one they have not yet acknowledged.
   */
  async countAwaitingSubmitter(personId: number): Promise<number> {
    const ids = await ports().personIds.storedIdsOf(personId);
    return receiptRepo.count({
      orgId: await getOrgId(),
      uploadedByUserId: { in: ids },
      OR: [
        {
          details: { state: { in: [...SUBMITTER_ACTION_STATES] } },
          NOT: { needsReimbursement: true, reimburseePersonId: { notIn: ids }, details: { state: "submitter_review" } },
        },
        { details: { state: "rejected", rejectionAcknowledgedAt: null } },
      ],
    });
  },

  /** The uploader acknowledges finance's rejection of their receipt, which leaves their pill. A repeat does nothing. */
  async acknowledgeRejection(id: string) {
    const actor = await requireActor();
    const row = await load(id, "submitter", actor);
    if (row.state !== "rejected") throw new ServiceError(400, "Only a rejected receipt is acknowledged");
    if (row.rejectionAcknowledgedAt === null) {
      const acknowledged = await db.receiptDetail.updateMany({ where: { id, rejectionAcknowledgedAt: null }, data: { rejectionAcknowledgedAt: new Date() } });
      if (acknowledged.count > 0) await audit(db, id, actor, { action: "rejection_acknowledged" });
    }
    return toSubmitterView(await load(id, "submitter", actor));
  },

  /**
   * How many reimbursements wait for this person's confirmation, for the host's nav pill: as the
   * person reimbursed, and, for a Board member, those only the Board can confirm, for a reimbursee
   * with no account.
   */
  async countToConfirm(personId: number, isBoardMember = false): Promise<number> {
    const [mine, onBehalf] = await Promise.all([
      awaitingConfirmation(personId),
      onBehalfConfirmations({ id: personId, name: null, firstName: "", lastName: "", isAdult: true, isBoardMember }),
    ]);
    return mine.inReview.length + mine.sent.size + onBehalf.rows.length;
  },

  async listAuditLogs(id: string) {
    const actor = await requireActor();
    await load(id, "finance", actor);
    return receiptRepo.listAuditLogs(id);
  },
};
