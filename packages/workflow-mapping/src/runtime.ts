import {
  inertCatalogEventSource,
  inertCatalogReader,
  inertCatalogSubmissions,
  inertDonationSink,
  inertExpenseSink,
  inertInventorySink,
  type CatalogEventSource,
  type CatalogReader,
  type CatalogSubmissions,
  type DonationSink,
  type ExpenseSink,
  type InventorySink,
  type OrgIdentity,
  type WorkflowPrincipal,
  type WorkflowRuntimeConfig,
} from "./contract";

export interface WorkflowPorts {
  catalogReader: CatalogReader;
  catalogSubmissions: CatalogSubmissions;
  expenseSink: ExpenseSink;
  donationSink: DonationSink;
  inventorySink: InventorySink;
  catalogEventSource: CatalogEventSource;
}

// ponytail: one runtime per process, on globalThis so HMR and split chunks share it.
const globalForRuntime = globalThis as typeof globalThis & { __wmRuntime?: WorkflowRuntimeConfig };

export function configureWorkflowMapping(config: WorkflowRuntimeConfig): void {
  globalForRuntime.__wmRuntime = config;
}

function requireRuntime(): WorkflowRuntimeConfig {
  const runtime = globalForRuntime.__wmRuntime;
  if (!runtime) {
    throw new Error("workflow-mapping runtime not configured — the host must call configureWorkflowMapping()");
  }
  return runtime;
}

export function getOrg(): Promise<OrgIdentity> {
  return requireRuntime().org();
}

export function httpError(status: number, message: string): Error {
  return requireRuntime().httpError(status, message);
}

export function ports(): WorkflowPorts {
  const r = requireRuntime();
  return {
    catalogReader: r.catalogReader ?? inertCatalogReader,
    catalogSubmissions: r.catalogSubmissions ?? inertCatalogSubmissions,
    expenseSink: r.expenseSink ?? inertExpenseSink,
    donationSink: r.donationSink ?? inertDonationSink,
    inventorySink: r.inventorySink ?? inertInventorySink,
    catalogEventSource: r.catalogEventSource ?? inertCatalogEventSource,
  };
}

/** The acting Person.id. Throws on anything but an integer. */
export function callerId(principal: { id: unknown }): number {
  const { id } = principal;
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("principal has no integer id");
  return id;
}

export interface Actor {
  id: number;
  name: string | null;
}

/** The authenticated actor, or a 401 when there is none or it has no integer id. */
export async function requireActor(): Promise<Actor> {
  const principal: WorkflowPrincipal | null = await requireRuntime().auth.getPrincipal();
  if (!principal || !Number.isInteger(principal.id)) throw httpError(401, "Unauthorized");
  return { id: callerId(principal), name: principal.name };
}
