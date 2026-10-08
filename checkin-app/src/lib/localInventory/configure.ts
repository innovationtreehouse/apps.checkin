/**
 * Wire the local-inventory library into checkin (#1287 §3/§6), called once at
 * server boot from instrumentation.ts. It shares the catalog's principal and
 * org accessors, so both libraries stamp the same org id and person ids.
 */
import { configureLocalInventory } from "@inventory/local-inventory";
import { getPrincipal, TREEHOUSE_ORG } from "@/lib/catalog/configure";

export function configureLocalInventoryRuntime(): void {
  configureLocalInventory({ auth: { getPrincipal }, org: () => TREEHOUSE_ORG });
}
