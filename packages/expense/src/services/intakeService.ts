// S2 callee: the orchestrator hands over a completed receipt's money side. Idempotent on
// receiptId — the "already applied" check lives here, so the in-process caller gets it.
import { CompletedReceiptSchema, type CompletedReceipt } from "@inventory/receipt-types";
import { db, isUniqueConstraintError } from "../db";
import { assertOrg } from "../runtime";
import type { ExpenseIntake } from "../contract";
import { initFinancialFlow, checkApprovalAutoTransition } from "../lib/financial-flow";
import { FLAG_AUDIENCE, detectIntakeFlags } from "../lib/flags";
import { SYSTEM_ACTOR } from "../lib/system-actor";
import { createProvisionalItemMapRepository } from "../repositories/provisionalItemMap";
import { createProvisionalResolutionRepository } from "../repositories/provisionalResolution";
import { createProvisionalItemMapService } from "./provisionalItemMapService";
import { readExpenseSettings } from "./settingsService";

export async function receiveCompletedReceipt(
  raw: unknown,
): Promise<{ receiptId: string; status: "created" | "already_applied" }> {
  const receipt = CompletedReceiptSchema.parse(raw);
  assertOrg(receipt.orgId);
  const already = { receiptId: receipt.receiptId, status: "already_applied" as const };

  const existingPayload = await db.receivedExpensePayload.findFirst({
    where: { receiptId: receipt.receiptId },
    select: { id: true, status: true },
  });
  if (existingPayload?.status === "applied") return already;

  const payloadJson = JSON.stringify(receipt);
  let payloadRowId: number;
  if (existingPayload) {
    await db.receivedExpensePayload.update({
      where: { id: existingPayload.id },
      data: { orgId: receipt.orgId, payloadJson, status: "applied", failureReason: null, receivedAt: new Date() },
    });
    payloadRowId = existingPayload.id;
  } else {
    try {
      const inserted = await db.receivedExpensePayload.create({
        data: { orgId: receipt.orgId, receiptId: receipt.receiptId, payloadJson, status: "applied" },
      });
      payloadRowId = inserted.id;
    } catch (err) {
      // A concurrent call for the same receipt won the insert and applies it.
      if (isUniqueConstraintError(err)) return already;
      throw err;
    }
  }

  try {
    await processCompletedReceipt(receipt);
  } catch (err) {
    await db.receivedExpensePayload.update({
      where: { id: payloadRowId },
      data: { status: "failed", failureReason: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
  return { receiptId: receipt.receiptId, status: "created" };
}

export const expenseIntake: ExpenseIntake = { receive: receiveCompletedReceipt };

async function processCompletedReceipt(receipt: CompletedReceipt): Promise<void> {
  const existingExpense = await db.expense.findFirst({ where: { id: receipt.receiptId } });

  if (existingExpense) {
    const approval = await db.lineItemOwnerApproval.findFirst({
      where: { expenseId: receipt.receiptId },
      select: { id: true },
    });
    if (!approval) await startFlow(receipt);
    return;
  }

  await db.$transaction(async (tx) => {
    await tx.expense.create({
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
        submittedAt: new Date(receipt.submittedAt),
        state: "pending",
        backfill: receipt.backfill,
      },
    });

    for (const li of receipt.lineItems) {
      await tx.expenseLineItem.create({
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
          gtin13: li.gtin13,
          isDelayed: li.isDelayed,
        },
      });
    }

    const settings = await readExpenseSettings(tx, receipt.orgId);
    await tx.expenseFlag.createMany({
      data: detectIntakeFlags(receipt, settings).map((kind) => ({
        orgId: receipt.orgId,
        expenseId: receipt.receiptId,
        kind,
        audience: FLAG_AUDIENCE[kind],
      })),
      skipDuplicates: true,
    });
  });

  const provisionalItemMapRepo = createProvisionalItemMapRepository(db);
  const provisionalResolutionRepo = createProvisionalResolutionRepository(db);
  const provisionalItemMapService = createProvisionalItemMapService({
    provisionalRepo: provisionalItemMapRepo,
    resolutionRepo: provisionalResolutionRepo,
    db,
  });

  for (const li of receipt.lineItems) {
    if (li.isProvisional && li.gtin13) {
      const exists = await provisionalItemMapRepo.findByGtin(receipt.orgId, li.gtin13);
      if (!exists) {
        await provisionalItemMapRepo.create({
          provisionalGtin13: li.gtin13,
          orgId: receipt.orgId,
          status: "pending",
          proposedAt: new Date(),
        });
      }

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

  await startFlow(receipt);
}

// Pre-approved lines (backfill, org-level buckets) drive owner_approval straight through.
async function startFlow(receipt: CompletedReceipt): Promise<void> {
  await initFinancialFlow(receipt.receiptId, receipt.orgId, receipt.backfill);
  await checkApprovalAutoTransition(receipt.receiptId, SYSTEM_ACTOR);
}
