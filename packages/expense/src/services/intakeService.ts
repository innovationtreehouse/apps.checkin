// S2 callee: the orchestrator hands over a completed receipt's money side. Idempotent on
// receiptId — the "already applied" check lives here, so the in-process caller gets it.
import { CompletedReceiptSchema, type CompletedReceipt } from "@checkin/receipt-types";
import { db, isUniqueConstraintError } from "../db";
import { assertOrg, getExpenseRuntime, getOrgId } from "../runtime";
import { logError } from "../lib/logger";
import type { ExpenseIntake } from "../contract";
import { initFinancialFlow, checkApprovalAutoTransition } from "../lib/financial-flow";
import { FLAG_AUDIENCE, detectIntakeFlags } from "../lib/flags";
import { withinEverydayLimits } from "../lib/signoff";
import { SYSTEM_ACTOR } from "../lib/system-actor";
import { createProvisionalItemMapRepository } from "../repositories/provisionalItemMap";
import { createProvisionalResolutionRepository } from "../repositories/provisionalResolution";
import { createProvisionalItemMapService } from "./provisionalItemMapService";
import { readExpenseSettings } from "./settingsService";
import { recordSubmitterSeats } from "./submitterSeatService";
import { ServiceError } from "@checkin/component-kit";

export async function receiveCompletedReceipt(
  raw: unknown,
): Promise<{ receiptId: string; status: "created" | "already_applied" }> {
  const receipt = CompletedReceiptSchema.parse(raw);
  await assertOrg(receipt.orgId);
  const { receiptId } = receipt;

  const existingPayload = await db.receivedExpensePayload.findFirst({ where: { receiptId }, select: { status: true, payloadJson: true } });
  if (existingPayload?.status === "applied") return { receiptId, status: "already_applied" };

  // Once the expense exists it was built from the stored payload, so a replay must match it.
  const payloadJson = JSON.stringify(receipt);
  if (existingPayload && existingPayload.payloadJson !== payloadJson && (await db.expense.count({ where: { id: receiptId } })) > 0) {
    throw new ServiceError(409, `Receipt ${receiptId} was already received with a different payload`);
  }

  // Record arrival as "received"; "applied" is written only after processing commits, so a crash
  // in between leaves a row the next call (or the catch-up sweep) finishes.
  const arrival = { orgId: receipt.orgId, payloadJson, status: "received", failureReason: null, receivedAt: new Date() };
  try {
    await db.receivedExpensePayload.upsert({ where: { receiptId }, create: { receiptId, ...arrival }, update: arrival });
  } catch (err) {
    // A concurrent call inserted the row first; processing below is idempotent.
    if (!isUniqueConstraintError(err)) throw err;
  }

  let created: boolean;
  try {
    created = await processCompletedReceipt(receipt);
  } catch (err) {
    await db.receivedExpensePayload.updateMany({
      where: { receiptId, status: { not: "applied" } },
      data: { status: "failed", failureReason: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
  await db.receivedExpensePayload.update({ where: { receiptId }, data: { status: "applied", failureReason: null } });
  return { receiptId, status: created ? "created" : "already_applied" };
}

/** Catch-up sweep: re-runs payloads left received or failed. Capped; counts only. */
export async function replayReceivedPayloads(limit = 50): Promise<{ applied: number; failed: number }> {
  const rows = await db.receivedExpensePayload.findMany({
    where: { orgId: await getOrgId(), status: { in: ["received", "failed"] } },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { payloadJson: true },
  });
  const counts = { applied: 0, failed: 0 };
  for (const r of rows) {
    try {
      await receiveCompletedReceipt(JSON.parse(r.payloadJson));
      counts.applied++;
    } catch (err) {
      counts.failed++;
      logError("intake_replay_failed", {}, err);
    }
  }
  return counts;
}

export const expenseIntake: ExpenseIntake = { receive: receiveCompletedReceipt };

/**
 * Creates the expense, tracks its provisional GTINs and starts its flow; true when this call
 * created the expense. Every step is idempotent, so a retry or a concurrent call resumes
 * wherever a previous call stopped.
 */
async function processCompletedReceipt(receipt: CompletedReceipt): Promise<boolean> {
  let created = false;
  const existingExpense = await db.expense.findFirst({ where: { id: receipt.receiptId }, select: { id: true } });
  if (!existingExpense) {
    try {
      await createExpense(receipt);
      created = true;
    } catch (err) {
      // A concurrent call created the expense first.
      if (!isUniqueConstraintError(err)) throw err;
    }
  }
  await trackProvisionals(receipt);
  await startFlow(receipt);
  return created;
}

async function createExpense(receipt: CompletedReceipt): Promise<void> {
  const reimburseePersonId = await resolvedReimbursee(receipt.reimburseePersonId ?? null);
  const unresolvedDetail =
    receipt.reimburseePersonId != null && reimburseePersonId === null ? `receipt named Person ${receipt.reimburseePersonId}, not found` : null;
  await db.$transaction(async (tx) => {
    const settings = await readExpenseSettings(tx, receipt.orgId);
    const review = receiptReviewOf(receipt);
    const { receiptReview } = await tx.expense.create({
      include: { receiptReview: true },
      data: {
        id: receipt.receiptId,
        orgId: receipt.orgId,
        submitterId: receipt.submitterId,
        vendorName: receipt.vendorName,
        receiptNumber: receipt.receiptNumber,
        orderNumber: receipt.orderNumber,
        currency: receipt.currency,
        taxCents: receipt.taxCents,
        shippingCents: receipt.shippingCents,
        discountCents: receipt.discountCents,
        receiptTotalCents: receipt.receiptTotalCents,
        receiptDate: receipt.receiptDate,
        needsReimbursement: receipt.needsReimbursement,
        reimbursementFor: receipt.reimbursementFor,
        reimburseePersonId,
        submittedAt: new Date(receipt.submittedAt),
        state: "pending",
        backfill: receipt.backfill,
        everydayWithinLimits: withinEverydayLimits(
          { receiptTotalCents: receipt.receiptTotalCents, unitPricesCents: receipt.lineItems.map((li) => li.unitPriceCents) },
          settings,
        ),
        everydayTotalLimitCents: settings.everydayTotalLimitCents,
        everydayItemLimitCents: settings.everydayItemLimitCents,
        receiptReview: review ? { create: review } : undefined,
      },
    });

    const lineItemIds: number[] = [];
    for (const li of receipt.lineItems) {
      const { id } = await tx.expenseLineItem.create({
        data: {
          expenseId: receipt.receiptId,
          receiptLineItemId: li.receiptLineItemId,
          lineNumber: li.lineNumber,
          description: li.description,
          partNumber: li.partNumber,
          manufacturer: li.manufacturer,
          quantity: li.quantity,
          unitPriceCents: li.unitPriceCents,
          totalPriceCents: li.totalPriceCents,
          // A non-inventory line is no catalog part, so it keeps no GTIN to map an owner by.
          gtin13: li.nonInventory ? null : li.gtin13,
          isDelayed: li.isDelayed,
          nonInventory: li.nonInventory ?? false,
        },
      });
      lineItemIds.push(id);
    }

    // The person reimbursed's confirmation signs every line: theirs, or a Board member's on their behalf.
    const confirmation = receipt.submitterConfirmation;
    if (receipt.needsReimbursement && !receipt.backfill && reimburseePersonId !== null && confirmation?.confirmedByPersonId === reimburseePersonId) {
      const signer = { userId: confirmation.onBehalfByPersonId ?? reimburseePersonId, username: null };
      await recordSubmitterSeats(tx, receipt.receiptId, lineItemIds, signer, { reimburseePersonId, confirmedAt: confirmation.confirmedAt });
    }

    await tx.expenseFlag.createMany({
      data: detectIntakeFlags({ ...receipt, reimburseePersonId, receiptReview }, settings).map((kind) => ({
        orgId: receipt.orgId,
        expenseId: receipt.receiptId,
        kind,
        audience: FLAG_AUDIENCE[kind],
        detail: kind === "REIMBURSEE_UNKNOWN" ? unresolvedDetail : null,
      })),
      skipDuplicates: true,
    });
  });
}

/** The receipt review to store with the expense, or null when the receipt sent neither part. */
function receiptReviewOf({ taxReviewRequired, financeReview }: CompletedReceipt) {
  if (taxReviewRequired === undefined && !financeReview) return null;
  return {
    taxReviewRequired: taxReviewRequired ?? null,
    reasons: financeReview?.reasons ?? [],
    approvedTaxCents: financeReview?.taxCents ?? null,
    approvedByUserId: financeReview?.decidedByPersonId ?? null,
    note: financeReview?.note ?? null,
    approvedAt: financeReview ? new Date(financeReview.decidedAt) : null,
  };
}

/** The receipt's reimbursee when it names a checkin Person; an unresolvable id is held as unknown. */
async function resolvedReimbursee(personId: number | null): Promise<number | null> {
  return personId !== null && (await getExpenseRuntime().signoff.personExists(personId)) ? personId : null;
}

async function trackProvisionals(receipt: CompletedReceipt): Promise<void> {
  const provisionalItemMapRepo = createProvisionalItemMapRepository(db);
  const provisionalResolutionRepo = createProvisionalResolutionRepository(db);
  const provisionalItemMapService = createProvisionalItemMapService({
    provisionalRepo: provisionalItemMapRepo,
    resolutionRepo: provisionalResolutionRepo,
    db,
  });

  for (const li of receipt.lineItems) {
    if (li.isProvisional && li.gtin13) {
      await db.provisionalItemMap.createMany({
        data: [{ provisionalGtin13: li.gtin13, orgId: receipt.orgId, status: "pending" }],
        skipDuplicates: true,
      });

      // Reconcile-on-ingest: a catalog S5 resolution may have arrived before this row existed.
      // The fact is recorded durably (provisional_resolutions); the service methods are idempotent.
      const resolution = await provisionalResolutionRepo.findByGtin(receipt.orgId, li.gtin13);
      if (resolution) {
        switch (resolution.kind) {
          case "approved":
            if (resolution.realGtin13) {
              await provisionalItemMapService.approveProvisional(receipt.orgId, li.gtin13, resolution.realGtin13);
            }
            break;
          case "mapped_to_existing":
            if (resolution.realGtin13) {
              await provisionalItemMapService.mapProvisionalToExisting(receipt.orgId, li.gtin13, resolution.realGtin13);
            }
            break;
          case "rejected":
            await provisionalItemMapService.rejectProvisional(receipt.orgId, li.gtin13, resolution.rejectionReason ?? undefined);
            break;
        }
      }
    }
  }
}

// Starts the flow once (initFinancialFlow claims the pending expense); pre-approved lines
// (backfill, org-level buckets) then drive owner_approval straight through. The backfill flag is
// the stored expense's, never the incoming payload's.
async function startFlow(receipt: CompletedReceipt): Promise<void> {
  const { backfill } = await db.expense.findUniqueOrThrow({ where: { id: receipt.receiptId }, select: { backfill: true } });
  await initFinancialFlow(receipt.receiptId, receipt.orgId, backfill);
  await checkApprovalAutoTransition(receipt.receiptId, SYSTEM_ACTOR);
}
