import { CompletedReceiptSchema } from "@inventory/receipt-types";
import { db } from "../db";
import type { ReceiptOrgSettings } from "../generated/prisma/client";
import { ingestResultSchema } from "../contract";
import { audit, receiptRepo, type Actor, type ReceiptRow } from "../repositories/receipt";
import { getOrg, ports } from "../runtime";
import { resolveNextState } from "../workflows/receipt.invariants";
import type { ReceiptMachineContext } from "../workflows/receipt.guards";

export function validateLineItemMath(
  lineItems: Array<{ quantity: number; unitPriceCents: number }>,
  shippingCents: number,
  taxCents: number,
  discountCents: number,
  receiptTotalCents: number,
): boolean {
  const lineSum = lineItems.reduce((acc, li) => acc + li.quantity * li.unitPriceCents, 0);
  return lineSum + shippingCents + taxCents - discountCents === receiptTotalCents;
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

export type FinancialReviewReason = "tax" | "old_date" | "future_date";

export function financialReviewReasons(row: ReceiptRow, settings: ReceiptOrgSettings): FinancialReviewReason[] {
  const { taxReview, ageReview, futureReview } = computeFinancialReviewFlags(
    settings,
    row.taxCents,
    row.receiptDate ?? "",
    row.isInKind,
  );
  const reasons: FinancialReviewReason[] = [];
  if (taxReview) reasons.push("tax");
  if (ageReview && !row.qbTxnId) reasons.push("old_date");
  if (futureReview) reasons.push("future_date");
  return reasons;
}

export function getOrgSettings(orgId: string): Promise<ReceiptOrgSettings> {
  return db.receiptOrgSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
}

/**
 * The receipt this one duplicates, or null. The file-hash suspect is the one stored at insert
 * under the per-file lock, so a receipt only ever duplicates one that existed before it. Once a
 * person has cleared the flag, the receipt is never re-flagged.
 */
export async function checkDuplicate(row: ReceiptRow): Promise<string | null> {
  if (row.duplicateFlagClearedAt) return null;
  if (row.duplicateSuspectReceiptId) return row.duplicateSuspectReceiptId;
  const { orgId, retailer, receiptDate, receiptTotalCents, orderNumber, receiptNumber, id } = row;
  const notSelf = { id: { not: id } };

  const composite = await db.receiptDetail.findFirst({ where: { orgId, retailer, receiptDate, receiptTotalCents, ...notSelf } });
  if (composite) return composite.id;
  if (orderNumber) {
    const byOrder = await db.receiptDetail.findFirst({ where: { orgId, retailer, orderNumber, ...notSelf } });
    if (byOrder) return byOrder.id;
  }
  if (receiptNumber) {
    const byNumber = await db.receiptDetail.findFirst({ where: { orgId, retailer, receiptNumber, ...notSelf } });
    if (byNumber) return byNumber.id;
  }
  return null;
}

/**
 * S1: deliver a finalized receipt to workflow-mapping. Never throws: a failure leaves `pushedAt`
 * null with an audit row, for the catch-up step or the manual button to resend.
 */
export async function pushReceipt(receiptId: string, actor: Actor | null): Promise<boolean> {
  try {
    const orgId = (await getOrg()).id;
    const row = await receiptRepo.find(receiptId, orgId);
    if (!row) throw new Error(`receipt ${receiptId} not found`);
    const lineItems = await receiptRepo.listLineItems(receiptId);
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
    await tx.receiptDetail.update({ where: { id: row.id }, data: { state: "receipt_finalized", validationNotes: null } });
    await audit(tx, row.id, actor, {
      action: "finalized",
      fieldChanged: "state",
      valueBefore: row.state,
      valueAfter: "receipt_finalized",
    });
  });
  await pushReceipt(row.id, actor);
}

/** Run the intake guard chain from `uploaded` (or `flow_error`) and persist where it lands. */
export async function runFullFlow(receiptId: string, actor: Actor | null): Promise<void> {
  const orgId = (await getOrg()).id;
  const row = await receiptRepo.find(receiptId, orgId);
  if (!row) return;
  if (!row.retailer || !row.receiptDate || row.receiptTotalCents === null) return;

  const lineItems = await receiptRepo.listLineItems(receiptId);
  const dupId = await checkDuplicate(row);
  const settings = await getOrgSettings(orgId);
  const valid = validateLineItemMath(lineItems, row.shippingCents, row.taxCents, row.discountCents, row.receiptTotalCents);
  const { taxReview, ageReview, futureReview, ageLimitDays, diffDays } = computeFinancialReviewFlags(
    settings,
    row.taxCents,
    row.receiptDate,
    row.isInKind,
  );

  // QB-linked backfill is already reconciled in QuickBooks: the submitter step is implied and the
  // age gate is waived (historical by definition). Tax, future-dated, math and dedup still apply.
  const isQbLinked = !!row.qbTxnId;

  const context: ReceiptMachineContext = {
    isDuplicate: !!dupId,
    mathValid: valid,
    needsReimbursement: row.needsReimbursement,
    cameByEmail: row.intakeSource === "email",
    readByOcr: row.ocrStartedAt !== null,
    submitterReviewed: !!row.reviewedAt || isQbLinked,
    financialApproved: !!row.approvedAt,
    needsFinancialReview: taxReview || futureReview || (ageReview && !isQbLinked),
  };

  const nextState = resolveNextState(row.state, { type: "RUN_PIPELINE" }, context);

  const transition = async (detail: Parameters<typeof receiptRepo.update>[1]["detail"], valueAfter: string) => {
    await receiptRepo.update(receiptId, { detail }, row.state);
    await audit(db, receiptId, actor, {
      action: "pipeline_transition",
      fieldChanged: "state",
      valueBefore: row.state,
      valueAfter,
    });
  };

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
    await receiptRepo.update(receiptId, { detail: { state: "flow_error" } });
    await audit(db, receiptId, actor, {
      action: "pipeline_failed",
      fieldChanged: "state",
      valueBefore: row.state,
      valueAfter: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
