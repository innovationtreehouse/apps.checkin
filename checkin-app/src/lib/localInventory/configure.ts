/**
 * Wire the local-inventory library into checkin, called once at
 * server boot from instrumentation.ts. It shares the host kit's principal and
 * lazy Org-registry accessor, so both libraries stamp the same org id and
 * person ids, and boot stays DB-free. The S5 replay read is bound to the catalog's events,
 * and the item reads to the shared catalog reader.
 */
import { configureLocalInventory } from "@checkin/local-inventory";
import { catalogReader } from "@/lib/catalog/reader";
import { catalogEventsSince, getOrg, getPrincipal } from "@/lib/components/host";

export function configureLocalInventoryRuntime(): void {
  configureLocalInventory({
    auth: { getPrincipal },
    org: getOrg,
    catalogEventSource: { eventsSince: catalogEventsSince },
    catalog: { getActiveItem: catalogReader.getActiveItem, searchItems: catalogReader.searchItems },
  });
}
