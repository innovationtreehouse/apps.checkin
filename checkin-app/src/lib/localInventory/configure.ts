/**
 * Wire the local-inventory library into checkin (#1287 §3/§6), called once at
 * server boot from instrumentation.ts. It shares the catalog's principal and
 * lazy Org-registry accessor, so both libraries stamp the same org id and
 * person ids, and boot stays DB-free.
 */
import { configureLocalInventory } from "@inventory/local-inventory";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";

export function configureLocalInventoryRuntime(): void {
  configureLocalInventory({ auth: { getPrincipal }, org: getOrg });
}
