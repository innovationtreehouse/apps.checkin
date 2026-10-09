/**
 * Wire the workflow-mapping library into checkin (#1289 §6/§8), called once at
 * server boot from instrumentation.ts. It shares the catalog's principal and
 * lazy Org-registry accessor, so every library stamps the same org and person
 * ids, and boot stays DB-free.
 *
 * Bound crossings: X4 (InventorySink → local-inventory apply). The catalog
 * ports (X3), expense (X5), donations (X9) and the S5 replay read (X2) keep
 * the library's inert adapters, so a receipt whose money leg cannot land waits
 * in apply_failed.
 */
import { configureWorkflowMapping } from "@inventory/workflow-mapping";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";
import { createLocalInventorySink } from "@/lib/workflowMapping/inventorySink";

/** The library's HTTP error; the route wrapper translates it into handler()'s ApiResponseError. */
export class WorkflowMappingHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowMappingHttpError";
  }
}

export function configureWorkflowMappingRuntime(): void {
  configureWorkflowMapping({
    auth: { getPrincipal },
    org: getOrg,
    httpError: (status, message) => new WorkflowMappingHttpError(status, message),
    inventorySink: createLocalInventorySink(getOrg),
  });
}
