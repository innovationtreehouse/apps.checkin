/**
 * Wire the global-catalog library into checkin (#1286 §3/§6), called once at
 * server boot from instrumentation.ts. Binding stays boot-clean: see the host kit.
 */
import { configureCatalog } from "@checkin/global-catalog";
import type { OrgEventConsumer } from "@checkin/global-catalog";
import { getOrg, getPrincipal } from "@/lib/components/host";

/**
 * The S5 consumers the catalog calls after each commit that wrote events. Each library parses
 * the events, applies them and keeps its own cursor; loaded on first event, never at boot.
 */
const orgEventConsumers: Record<string, OrgEventConsumer> = {
  localInventory: {
    async onOrgEvents(events) {
      await (await import("@checkin/local-inventory")).orgEventConsumer.onOrgEvents(events);
    },
  },
  expense: {
    async onOrgEvents(events) {
      const { consumeCatalogEvent } = await import("@checkin/expense");
      for (const event of events) await consumeCatalogEvent(event);
    },
  },
  workflowMapping: {
    async onOrgEvents(events) {
      await (await import("@checkin/workflow-mapping")).orgEventConsumer.onOrgEvents(events);
    },
  },
};

export function configureCatalogRuntime(): void {
  configureCatalog({ auth: { getPrincipal }, org: getOrg, orgEventConsumers });
}
