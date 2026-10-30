/**
 * Wire the local-inventory library into checkin, called once at
 * server boot from instrumentation.ts. It shares the host kit's principal and
 * lazy Org-registry accessor, so both libraries stamp the same org id and
 * person ids, and boot stays DB-free. The S5 replay read is bound to the catalog's events.
 */
import { configureLocalInventory, type InventoryAlerts } from "@checkin/local-inventory";
import { catalogEventsSince, getOrg, getPrincipal } from "@/lib/components/host";

const alerts: InventoryAlerts = {
  async orgEventsStuck({ failed, unprocessed, unreadable }) {
    const { emailBoardMembers } = await import("@/lib/emailRecipients");
    const problem = unreadable
      ? "could not read the catalog's events"
      : `found ${failed} newly failed and ${unprocessed} unprocessed catalog event(s)`;
    await emailBoardMembers(
      "Inventory: catalog events need attention",
      `<p>The inventory catch-up ${problem}. Until they apply, provisional items the catalog has reviewed can stay pending. The daily run keeps retrying; an engineer should check the reconcile logs. A failed event alerts only once.</p>`,
      "Inventory catalog event alert failed:",
    );
  },
};

export function configureLocalInventoryRuntime(): void {
  configureLocalInventory({ auth: { getPrincipal }, org: getOrg, catalogEventSource: { eventsSince: catalogEventsSince }, alerts });
}
