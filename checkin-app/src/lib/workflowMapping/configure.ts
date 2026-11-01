/**
 * Wire the workflow-mapping library into checkin, called once at
 * server boot from instrumentation.ts. It shares the host kit's principal and
 * lazy Org-registry accessor, so every library stamps the same org and person
 * ids, and boot stays DB-free.
 *
 * Bound crossings: CatalogReader → catalog reads, CatalogSubmissions →
 * catalog proposals, conflicts and provisional GTINs, InventorySink →
 * local-inventory apply, ExpenseSink → expense intake, DonationSink →
 * donations ingestInKind, and the org-event replay read.
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
 * The intake parses the receipt, asserts the org and dedupes on
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
