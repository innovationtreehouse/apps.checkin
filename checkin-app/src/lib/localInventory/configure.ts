/**
 * Wire the local-inventory library into checkin, called once at
 * server boot from instrumentation.ts. It shares the host kit's principal and
 * lazy Org-registry accessor, so both libraries stamp the same org id and
 * person ids, and boot stays DB-free. The S5 replay read is bound to the catalog's events,
 * and the item read to the shared catalog reader.
 */
import { configureLocalInventory } from "@checkin/local-inventory";
import { catalogReader } from "@/lib/catalog/reader";
import { catalogEventsSince, getOrg, getPrincipal } from "@/lib/components/host";
import { orgEventAlerts } from "@/lib/components/orgEventAlerts";

const alerts = orgEventAlerts("board.inventoryEventsStuck", "Inventory catalog event alert failed:");

export function configureLocalInventoryRuntime(): void {
  configureLocalInventory({
    auth: { getPrincipal },
    org: getOrg,
    catalogEventSource: { eventsSince: catalogEventsSince },
    catalog: { getItem: catalogReader.getItem },
    alerts,
  });
}
