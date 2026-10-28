import { db } from "../db";
import { checkImportBatch } from "../lib/importBatch";
import { insertReceiptsTogether } from "../lib/insert";
import { runFullFlow } from "../lib/receipt-flow";
import { getOrg, requireActor } from "../runtime";
import { ServiceError } from "@checkin/component-kit";

export interface ImportRowResult {
  importSourceId: string;
  status: "processed" | "skipped";
  id?: string;
  state?: string;
  /** Why the pipeline failed for an imported row, which then stays in flow_error. */
  error?: string;
}

// A batch's inserts share one transaction; 50 files of up to 10 MB need more than Prisma's 5 s default.
const IMPORT_TRANSACTION_MS = 120_000;

/**
 * Bulk import of historical receipts already matched to QuickBooks (FINANCE). The whole file or
 * nothing: a batch with any malformed row or missing required data is refused before anything is
 * written, and every new row is inserted in one transaction. Each inserted row then runs the same
 * intake pipeline as an upload, after the commit, because finalizing pushes it downstream and that
 * cannot roll back; a row whose pipeline fails stays imported in flow_error. Its QB linkage waives
 * only the submitter step and the age gate. Records purchases only, never a reimbursement claim.
 * Idempotent per (org, importSourceId): a re-run skips rows already loaded, and runs the pipeline
 * of any it finds still in "uploaded". A row the daily sweep has moved to flow_error is finance's
 * to restart from its queue, like any other flow_error receipt.
 */
export async function importReceipts(rawBatch: unknown) {
  const actor = await requireActor();
  const checked = checkImportBatch(rawBatch);
  if (!checked.ok) throw new ServiceError(400, `Import refused; nothing was imported. ${checked.problems.join("; ")}`);
  const orgId = (await getOrg()).id;

  const loaded = await db.receiptDetail.findMany({
    where: { orgId, importSourceId: { in: checked.rows.map(({ row }) => row.importSourceId) } },
    select: { id: true, importSourceId: true, state: true },
  });
  const skip = new Set(loaded.map((d) => d.importSourceId));
  const fresh = checked.rows.filter(({ row }) => !skip.has(row.importSourceId));
  // A row a failed run left in "uploaded" never ran its pipeline, so this run resumes it.
  const resume = new Map(loaded.flatMap((d): [string, string][] => (d.state === "uploaded" && d.importSourceId ? [[d.importSourceId, d.id]] : [])));

  const ids = await insertReceiptsTogether(
    fresh.map(({ row: r, file, mimeType }) => ({
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
    })),
    IMPORT_TRANSACTION_MS,
  ).catch((err: unknown) => {
    throw new ServiceError(500, `Import refused; nothing was imported. ${err instanceof Error ? err.message : String(err)}`);
  });

  const imported = new Map([...resume, ...fresh.map(({ row }, i): [string, string] => [row.importSourceId, ids[i]])]);
  const results: ImportRowResult[] = [];
  for (const { row } of checked.rows) {
    const id = imported.get(row.importSourceId);
    if (!id) {
      results.push({ importSourceId: row.importSourceId, status: "skipped" });
      continue;
    }
    const error = await runFullFlow(id, actor).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    const after = await db.receiptDetail.findUnique({ where: { id }, select: { state: true } });
    results.push({ importSourceId: row.importSourceId, status: "processed", id, state: after?.state, ...(error ? { error } : {}) });
  }

  const byState: Record<string, number> = {};
  for (const x of results) if (x.status === "processed" && x.state) byState[x.state] = (byState[x.state] ?? 0) + 1;
  return {
    processed: results.filter((x) => x.status === "processed").length,
    skipped: results.filter((x) => x.status === "skipped").length,
    byState,
    results,
  };
}
