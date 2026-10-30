/**
 * Wire the workflow-mapping library into checkin, called once at
 * server boot from instrumentation.ts. It shares the host kit's principal and
 * lazy Org-registry accessor, so every library stamps the same org and person
 * ids, and boot stays DB-free.
 *
 * Bound crossings: X3 (CatalogReader → catalog reads), X8 (CatalogSubmissions →
 * catalog proposals, conflicts and provisional GTINs), X4 (InventorySink →
 * local-inventory apply), X5 (ExpenseSink → expense intake), X9 (DonationSink →
 * donations ingestInKind) and the S5 replay read (X2).
 */
import { configureWorkflowMapping, type ExpenseSink } from "@checkin/workflow-mapping";
import { expenseIntake } from "@checkin/expense";
import { ingestInKind } from "@checkin/bulk-donation";
import { catalogEventsSince, getOrg, getPrincipal } from "@/lib/components/host";
import { orgEventAlerts } from "@/lib/components/orgEventAlerts";
import { catalogReader } from "@/lib/catalog/reader";
import { createCatalogSubmissions } from "@/lib/catalog/submissions";
import { createLocalInventorySink } from "@/lib/workflowMapping/inventorySink";

/**
 * X5: the intake parses the receipt, asserts the org and dedupes on
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
    catalogReader,
    catalogSubmissions: createCatalogSubmissions(getOrg),
    inventorySink: createLocalInventorySink(getOrg),
    catalogEventSource: { eventsSince: catalogEventsSince },
    alerts: orgEventAlerts("board.receiptMappingEventsStuck", "Receipt mapping catalog event alert failed:"),
    expenseSink,
    donationSink: { ingestInKind },
  });
}
