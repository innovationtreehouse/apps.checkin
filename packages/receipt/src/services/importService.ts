import { db } from "../db";
import { checkImportBatch } from "../lib/importBatch";
import { insertReceipt } from "../lib/insert";
import { runFullFlow } from "../lib/receipt-flow";
import { getOrg, requireActor } from "../runtime";
import { ServiceError } from "@checkin/component-kit";

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
 * age gate. Records purchases only, never a reimbursement claim. A batch with any malformed row
 * or missing required data is refused whole, nothing imported. Idempotent per
 * (org, importSourceId): a re-run skips rows already loaded.
 */
export async function importReceipts(rawBatch: unknown) {
  const actor = await requireActor();
  const checked = checkImportBatch(rawBatch);
  if (!checked.ok) throw new ServiceError(400, `Import refused; nothing was imported. ${checked.problems.join("; ")}`);
  const orgId = (await getOrg()).id;

  const results: ImportRowResult[] = [];
  for (const { row: r, file, mimeType } of checked.rows) {
    try {
      const existing = await db.receiptDetail.findFirst({ where: { orgId, importSourceId: r.importSourceId }, select: { id: true } });
      if (existing) {
        results.push({ importSourceId: r.importSourceId, status: "skipped" });
        continue;
      }
      const id = await insertReceipt({
        orgId,
        actor,
        file,
        mimeType,
        core: { needsReimbursement: false, reimbursementFor: null, intakeSource: "import" },
        detail: {
          retailer: r.retailer,
          receiptNumber: r.receiptNumber ?? null,
          orderNumber: r.orderNumber ?? null,
          receiptDate: r.receiptDate,
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
