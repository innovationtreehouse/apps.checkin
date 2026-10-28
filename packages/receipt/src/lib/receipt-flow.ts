import { CompletedReceiptSchema, type FinancialReviewReason } from "@checkin/receipt-types";
import { db, type Db } from "../db";
import type { Prisma, ReceiptOrgSettings } from "../generated/prisma/client";
import { ingestResultSchema } from "../contract";
import { audit, ReceiptStateConflictError, receiptRepo, type Actor, type ReceiptRow } from "../repositories/receipt";
import { getOrg, ports } from "../runtime";
import { sendDonorSync } from "./donor-sync";
import { duplicateGroup } from "./duplicateGroup";
import { resolveNextState } from "../workflows/receipt.invariants";
import { NEUTRAL_CONTEXT, type ReceiptMachineContext } from "../workflows/receipt.guards";
import { receiptMath, type MathLine } from "./lineMath";
import { missingDetails, missingDetailsNote } from "./missingDetails";
import { describeCorrection, submitterCorrections } from "./submitterCorrections";

export function validateLineItemMath(
  lineItems: MathLine[],
  shippingCents: number,
  taxCents: number,
  discountCents: number,
  receiptTotalCents: number,
): boolean {
  return receiptMath(lineItems, shippingCents, taxCents, discountCents, receiptTotalCents).balanced;
}

export function computeFinancialReviewFlags(
  settings: ReceiptOrgSettings,
  taxCents: number,
  receiptDate: string,
  isInKind: boolean,
): { taxReview: boolean; ageReview: boolean; futureReview: boolean; ageLimitDays: number; diffDays: number } {
  const diffDays = Math.floor((Date.now() - new Date(receiptDate).getTime()) / (1000 * 60 * 60 * 24));
  // The org paid no tax on donated goods, so the tax check does not apply in-kind.
  const taxReview = !isInKind && taxCents > 0 && settings.taxExempt && settings.requireFinanceReviewWithTax;
  const ageLimitDays = settings.receiptAgeLimitDays;
  const ageReview = settings.enforceReceiptAgeLimit && ageLimitDays > 0 && diffDays > ageLimitDays;
  const futureReview = diffDays < 0;
  return { taxReview, ageReview, futureReview, ageLimitDays, diffDays };
}

/** Receipt fields that drive financial review; a submitter's change to one sends the receipt to finance. */
export const SUBMITTER_CORRECTION_FIELDS: readonly string[] = ["taxCents", "receiptDate"];

/**
 * The review flags for a receipt. Tax and age also check the values its submitter corrected away,
 * read from the audited field edits, so a correction never drops a reason the original raised.
 */
async function reviewFlags(row: ReceiptRow, settings: ReceiptOrgSettings) {
  const edits = await db.receiptAuditLog.findMany({
    where: {
      receiptId: row.id,
      action: "field_edit",
      userId: row.uploadedByUserId,
      fieldChanged: { in: [...SUBMITTER_CORRECTION_FIELDS] },
    },
    select: { fieldChanged: true, valueBefore: true },
    orderBy: [{ changedAt: "asc" }, { id: "asc" }],
  });
  const before = (field: string) =>
    edits.flatMap((e) => (e.fieldChanged === field && e.valueBefore !== null ? [e.valueBefore] : []));
  const date = row.receiptDate ?? "";
  const flags = (taxCents: number, receiptDate: string) => computeFinancialReviewFlags(settings, taxCents, receiptDate, row.isInKind);
  const current = flags(row.taxCents, date);
  return {
    ...current,
    taxReview: current.taxReview || before("taxCents").some((t) => flags(Number(t), date).taxReview),
    ageReview: current.ageReview || before("receiptDate").some((d) => flags(row.taxCents, d).ageReview),
    corrected: edits.length > 0,
    corrections: submitterCorrections(edits, row),
  };
}

export async function financialReviewReasons(row: ReceiptRow, settings: ReceiptOrgSettings): Promise<FinancialReviewReason[]> {
  const { taxReview, ageReview, futureReview, corrected } = await reviewFlags(row, settings);
  const reasons: FinancialReviewReason[] = [];
  if (taxReview) reasons.push("tax");
  if (ageReview && !row.qbTxnId) reasons.push("old_date");
  if (futureReview) reasons.push("future_date");
  if (corrected) reasons.push("submitter_correction");
  return reasons;
}

/**
 * The org's settings, created with defaults on first read. ON CONFLICT DO NOTHING (skipDuplicates)
 * lets concurrent first reads all succeed, where an upsert's find-then-create would race.
 */
export async function getOrgSettings(orgId: string, client: Db | Prisma.TransactionClient = db): Promise<ReceiptOrgSettings> {
  await client.receiptOrgSettings.createMany({ data: [{ orgId }], skipDuplicates: true });
  return client.receiptOrgSettings.findUniqueOrThrow({ where: { orgId } });
}

/** The audit action of a mailed body discarded as a copy of a receipt from its own message. */
export const BODY_COPY_DISCARDED = "body_copy_discarded";

/**
 * The earliest live member of this receipt's duplicate group still undecided against it, or
 * null when it has none and so is not held. Every member counts, earlier or later, open,
 * finalized or rejected, except one finance rejected as a copy of it, or kept in its place.
 */
export async function checkDuplicate(row: ReceiptRow): Promise<string | null> {
  const group = await duplicateGroup(row.orgId, row.id);
  const copies = await db.receiptPairDecision.findMany({
    where: { kind: "copy_of", OR: [{ receiptId: row.id }, { otherReceiptId: row.id }] },
    select: { receiptId: true, otherReceiptId: true },
  });
  const decided = new Set(copies.map((p) => (p.receiptId === row.id ? p.otherReceiptId : p.receiptId)));
  return group?.members.find((m) => m.id !== row.id && m.state !== "discarded" && !decided.has(m.id))?.id ?? null;
}

/**
 * The confirmation that signs a reimbursement: the person reimbursed's, given by them or by a Board
 * member on their behalf. A confirmation with no recorded confirmer was the uploader's, so it counts
 * only when the uploader is the person reimbursed.
 */
function submitterConfirmation(row: ReceiptRow) {
  if (!row.reviewedAt || !row.needsReimbursement || row.reimburseePersonId == null) return undefined;
  const confirmer = row.reviewedByUserId ?? (row.uploadedByUserId === row.reimburseePersonId ? row.uploadedByUserId : null);
  if (confirmer === null) return undefined;
  return {
    confirmedByPersonId: row.reimburseePersonId,
    onBehalfByPersonId: confirmer === row.reimburseePersonId ? undefined : confirmer,
    onBehalfReason: confirmer === row.reimburseePersonId ? undefined : (row.reviewedOnBehalfReason ?? undefined),
    confirmedAt: row.reviewedAt.toISOString(),
  };
}

/**
 * S1: deliver a finalized receipt to workflow-mapping. Never throws: a failure leaves `pushedAt`
 * null with an audit row, for the catch-up step or the manual button to resend. A receipt whose
 * donor sync is still pending is held back, so donations has the final in-kind state (and refuses
 * any older call still in flight) before the money side reaches it.
 */
export async function pushReceipt(receiptId: string, actor: Actor | null): Promise<boolean> {
  try {
    const orgId = (await getOrg()).id;
    await sendDonorSync(receiptId, actor);
    const row = await receiptRepo.find(receiptId, orgId);
    if (!row) throw new Error(`receipt ${receiptId} not found`);
    if (row.state !== "receipt_finalized") throw new Error(`receipt is ${row.state}, not finalized`);
    if (row.donorSync === "pending") {
      await audit(db, receiptId, actor, { action: "push_deferred", valueAfter: "donor sync pending" });
      return false;
    }
    const lineItems = await receiptRepo.listLineItems(receiptId);
    const review = await db.receiptFinanceReview.findUnique({ where: { receiptId } });
    const { taxReview } = computeFinancialReviewFlags(await getOrgSettings(orgId), row.taxCents, row.receiptDate ?? "", row.isInKind);
    const payload = CompletedReceiptSchema.refine((r) => r.orgId === orgId, {
      message: "receipt orgId does not match this org",
      path: ["orgId"],
    }).parse({
      receiptId,
      orgId,
      submitterId: row.uploadedByUserId,
      vendorName: row.retailer ?? null,
      receiptNumber: row.receiptNumber ?? null,
      orderNumber: row.orderNumber ?? null,
      currency: row.currency,
      taxCents: row.taxCents,
      shippingCents: row.shippingCents,
      discountCents: row.discountCents,
      receiptTotalCents: row.receiptTotalCents,
      receiptDate: row.receiptDate ?? null,
      needsReimbursement: row.needsReimbursement,
      reimbursementFor: row.reimbursementFor ?? null,
      reimburseePersonId: row.reimburseePersonId ?? undefined,
      submittedAt: new Date().toISOString(),
      // QB-linked ⇒ historical backfill: downstream skips the QB re-post.
      backfill: !!row.qbTxnId,
      isInKind: row.isInKind,
      submitterConfirmation: submitterConfirmation(row),
      financeReview:
        review?.outcome === "approved"
          ? {
              outcome: review.outcome,
              reasons: review.reasons,
              decidedByPersonId: review.decidedByUserId,
              note: review.note,
              taxCents: review.taxCents ?? undefined,
              decidedAt: review.decidedAt.toISOString(),
            }
          : undefined,
      taxReviewRequired: taxReview,
      lineItems: lineItems.map((li) => ({
        receiptLineItemId: li.id,
        lineNumber: li.lineNumber,
        description: li.description,
        partNumber: li.partNumber ?? null,
        manufacturer: li.manufacturer ?? null,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        totalPriceCents: li.totalPriceCents,
        isDelayed: li.isDelayed,
      })),
    });
    const result = ingestResultSchema.parse(await ports().receiptSink.ingestReceipt(payload));
    await db.$transaction(async (tx) => {
      await tx.receipt.update({ where: { id: receiptId }, data: { pushedAt: new Date() } });
      await audit(tx, receiptId, actor, { action: "pushed", valueAfter: result.created ? "created" : "replayed" });
    });
    return true;
  } catch (err) {
    await audit(db, receiptId, actor, {
      action: "push_failed",
      valueAfter: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return false;
  }
}

async function finalizeReceipt(row: ReceiptRow, actor: Actor | null): Promise<void> {
  await db.$transaction(async (tx) => {
    await receiptRepo.update(row.id, { detail: { state: "receipt_finalized", validationNotes: null } }, row.state, tx);
    await audit(tx, row.id, actor, {
      action: "finalized",
      fieldChanged: "state",
      valueBefore: row.state,
      valueAfter: "receipt_finalized",
    });
  });
  await pushReceipt(row.id, actor);
}

/**
 * Run the intake guard chain from `uploaded` (or `flow_error`) and persist where it lands. A
 * receipt missing its retailer, date or total goes to its submitter before any other check.
 * Every write is conditional on the state read here: when another step moved the receipt first,
 * that step stands and the flow writes nothing.
 */
export async function runFullFlow(receiptId: string, actor: Actor | null): Promise<void> {
  const orgId = (await getOrg()).id;
  const row = await receiptRepo.find(receiptId, orgId);
  if (!row || (row.state !== "uploaded" && row.state !== "flow_error")) return;

  const transition = async (detail: Parameters<typeof receiptRepo.update>[1]["detail"], valueAfter: string) => {
    try {
      await receiptRepo.update(receiptId, { detail }, row.state);
    } catch (err) {
      if (err instanceof ReceiptStateConflictError) return;
      throw err;
    }
    await audit(db, receiptId, actor, {
      action: "pipeline_transition",
      fieldChanged: "state",
      valueBefore: row.state,
      valueAfter,
    });
  };

  const total = row.receiptTotalCents;
  const missing = missingDetails(row);
  if (total === null || missing.length > 0) {
    const held = resolveNextState(row.state, { type: "RUN_PIPELINE" }, { ...NEUTRAL_CONTEXT, detailsMissing: true });
    if (held !== "submitter_review") throw new Error(`Unexpected next state '${held}' from '${row.state}' for a receipt missing details`);
    await transition({ state: "submitter_review", validationNotes: missingDetailsNote(missing) }, `submitter_review (missing ${missing.join(", ")})`);
    return;
  }

  const lineItems = await receiptRepo.listLineItems(receiptId);
  const dupId = await checkDuplicate(row);
  const settings = await getOrgSettings(orgId);
  const valid = validateLineItemMath(lineItems, row.shippingCents, row.taxCents, row.discountCents, total);
  const { taxReview, ageReview, futureReview, corrected, corrections, ageLimitDays, diffDays } = await reviewFlags(row, settings);

  // QB-linked backfill is already reconciled in QuickBooks: the submitter step is implied and the
  // age gate is waived (historical by definition). Tax, future-dated, math and dedup still apply.
  const isQbLinked = !!row.qbTxnId;

  const context: ReceiptMachineContext = {
    detailsMissing: false,
    isDuplicate: !!dupId,
    mathValid: valid,
    needsReimbursement: row.needsReimbursement,
    cameByEmail: row.intakeSource === "email",
    readByOcr: row.ocrStartedAt !== null,
    submitterReviewed: !!row.reviewedAt || isQbLinked,
    financialApproved: !!row.approvedAt,
    needsFinancialReview: taxReview || futureReview || (ageReview && !isQbLinked) || corrected,
  };

  const nextState = resolveNextState(row.state, { type: "RUN_PIPELINE" }, context);

  try {
    switch (nextState) {
      case "duplicate_flagged":
        await transition(
          { state: "duplicate_flagged", duplicateFlaggedAt: new Date(), duplicateSuspectReceiptId: dupId },
          `duplicate_flagged (suspect: ${dupId})`,
        );
        return;
      case "validation_failed":
        await transition(
          { state: "validation_failed", validationNotes: "Line items total does not match the receipt total." },
          "validation_failed (line items total does not match receipt total)",
        );
        return;
      case "submitter_review":
        await transition({ state: "submitter_review" }, "submitter_review");
        return;
      case "financial_review": {
        const reasons = [
          taxReview && "tax review required (tax-exempt org with tax > 0)",
          ageReview && `age limit exceeded (${diffDays}d > ${ageLimitDays}d)`,
          futureReview && "future-dated receipt",
          corrected && corrections.map(describeCorrection).join("; "),
        ]
          .filter(Boolean)
          .join("; ");
        await transition({ state: "financial_review" }, reasons ? `financial_review (${reasons})` : "financial_review");
        return;
      }
      case "receipt_finalized":
        await finalizeReceipt(row, actor);
        return;
      default:
        if (nextState === row.state) throw new Error(`Machine blocked RUN_PIPELINE from state '${row.state}'`);
        throw new Error(`Unexpected next state '${nextState}' from '${row.state}'`);
    }
  } catch (err) {
    if (err instanceof ReceiptStateConflictError) return;
    try {
      await receiptRepo.update(receiptId, { detail: { state: "flow_error" } }, row.state);
    } catch (conflict) {
      throw conflict instanceof ReceiptStateConflictError ? err : conflict;
    }
    await audit(db, receiptId, actor, {
      action: "pipeline_failed",
      fieldChanged: "state",
      valueBefore: row.state,
      valueAfter: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
