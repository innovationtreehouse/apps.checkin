/**
 * Wire the workflow-mapping library into checkin (#1289 §6/§8), called once at
 * server boot from instrumentation.ts. It shares the catalog's principal and
 * lazy Org-registry accessor, so every library stamps the same org and person
 * ids, and boot stays DB-free.
 *
 * Bound crossings: X3 (CatalogReader → catalog reads), X4 (InventorySink →
 * local-inventory apply), X5 (ExpenseSink → expense intake), X9 (DonationSink →
 * donations ingestInKind) and the S5 replay read (X2). Catalog submissions keep
 * the library's inert adapters, so a receipt whose money leg cannot land waits
 * in apply_failed.
 */
import { configureWorkflowMapping, type ExpenseSink } from "@inventory/workflow-mapping";
import { expenseIntake } from "@inventory/expense";
import { ingestInKind } from "@inventory/bulk-donation";
import { catalogEventsSince, getOrg, getPrincipal } from "@/lib/catalog/configure";
import { catalogReader } from "@/lib/catalog/reader";
import { createLocalInventorySink } from "@/lib/workflowMapping/inventorySink";

const HTTP_ERROR_NAME = "WorkflowMappingHttpError";

/** The library's HTTP error; the route wrapper translates it into handler()'s ApiResponseError. */
export class WorkflowMappingHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = HTTP_ERROR_NAME;
  }
}

/**
 * Checked by name, not `instanceof`: the error is built by the configure call in
 * the instrumentation bundle, while routes load their own copy of this module.
 */
export function isWorkflowMappingHttpError(err: unknown): err is WorkflowMappingHttpError {
  return err instanceof Error && err.name === HTTP_ERROR_NAME && typeof (err as { status?: unknown }).status === "number";
}

/**
 * X5 (#1289 §8b): the intake parses the receipt, asserts the org and dedupes on
 * receiptId itself; its errors propagate so the money leg lands in apply_failed.
 */
export const expenseSink: ExpenseSink = {
  async pushReceipt(receipt) {
    await expenseIntake.receive(receipt);
  },
};

export function configureRuntime(): void {
  configureWorkflowMapping({
    auth: { getPrincipal },
    org: getOrg,
    httpError: (status, message) => new WorkflowMappingHttpError(status, message),
    catalogReader,
    inventorySink: createLocalInventorySink(getOrg),
    catalogEventSource: { eventsSince: catalogEventsSince },
    expenseSink,
    donationSink: { ingestInKind },
  });
}
