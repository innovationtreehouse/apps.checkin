import { db } from "../db";
import { checkReceiptFile } from "../lib/file-type";
import { insertReceipt } from "../lib/insert";
import { runFullFlow } from "../lib/receipt-flow";
import { ImportBatchSchema } from "../lib/schemas";
import { getOrg, requireActor } from "../runtime";
import { ServiceError } from "./serviceError";

export interface ImportRowResult {
  importSourceId: string;
  status: "processed" | "skipped" | "error";
  id?: string;
  state?: string;
  error?: string;
}

/**
 * Bulk import of historical receipts already matched to QuickBooks (FINANCE). Each row runs
 * the same intake pipeline as an upload; its QB linkage waives only the submitter step and the
 * age gate. Idempotent per (org, importSourceId): a re-run skips rows already loaded.
 */
export async function importReceipts(rawBatch: unknown) {
  const actor = await requireActor();
  const parsed = ImportBatchSchema.safeParse(rawBatch);
  if (!parsed.success) throw new ServiceError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const orgId = getOrg().id;

  const results: ImportRowResult[] = [];
  for (const r of parsed.data) {
    try {
      const existing = await db.receiptDetail.findFirst({ where: { orgId, importSourceId: r.importSourceId }, select: { id: true } });
      if (existing) {
        results.push({ importSourceId: r.importSourceId, status: "skipped" });
        continue;
      }
      const file = Buffer.from(r.fileBase64, "base64");
      const check = checkReceiptFile(file, r.mimeType);
      if (!check.ok) throw new ServiceError(400, check.error);

      const id = await insertReceipt({
        orgId,
        actor,
        file,
        mimeType: check.mimeType,
        core: { needsReimbursement: r.needsReimbursement, reimbursementFor: r.reimbursementFor ?? null, intakeSource: "import" },
        detail: {
          retailer: r.retailer,
          receiptNumber: r.receiptNumber ?? null,
          orderNumber: r.orderNumber ?? null,
          receiptDate: r.receiptDate ?? null,
          currency: r.currency,
          shippingCents: r.shippingCents,
          taxCents: r.taxCents,
          discountCents: r.discountCents,
          receiptTotalCents: r.receiptTotalCents,
          state: "uploaded",
          qbTxnId: r.qbTxnId,
          qbEntity: r.qbEntity ?? null,
          importSourceId: r.importSourceId,
        },
        lines: r.lineItems,
        auditAction: "imported",
      });
      await runFullFlow(id, actor);
      const after = await db.receiptDetail.findUnique({ where: { id }, select: { state: true } });
      results.push({ importSourceId: r.importSourceId, status: "processed", id, state: after?.state });
    } catch (err) {
      results.push({ importSourceId: r.importSourceId, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const byState: Record<string, number> = {};
  for (const x of results) if (x.status === "processed" && x.state) byState[x.state] = (byState[x.state] ?? 0) + 1;
  return {
    processed: results.filter((x) => x.status === "processed").length,
    skipped: results.filter((x) => x.status === "skipped").length,
    errors: results.filter((x) => x.status === "error").length,
    byState,
    results,
  };
}
