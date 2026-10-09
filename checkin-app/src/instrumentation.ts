/**
 * Next.js server-boot hook. Runs once per server process before requests.
 * Wires the checkin-hosted library runtimes (#1286 §3, #1287 §3, #1289) — Node
 * runtime only. Binding touches no database.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ configureCatalogRuntime }, { configureLocalInventoryRuntime }, { configureWorkflowMappingRuntime }] =
    await Promise.all([
      import("@/lib/catalog/configure"),
      import("@/lib/localInventory/configure"),
      import("@/lib/workflowMapping/configure"),
    ]);
  configureCatalogRuntime();
  configureLocalInventoryRuntime();
  configureWorkflowMappingRuntime();
}
