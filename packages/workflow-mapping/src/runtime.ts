import { callerId, defineRuntime } from "@checkin/component-kit";
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

export const workflowRuntime = defineRuntime<WorkflowRuntimeConfig, WorkflowPrincipal>("workflow-mapping");
const requireRuntime = workflowRuntime.require;

export const configureWorkflowMapping = workflowRuntime.configure;

export function getOrg(): Promise<OrgIdentity> {
  return requireRuntime().org();
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

export { callerId };

export interface Actor {
  id: number;
  name: string | null;
}

/** The authenticated actor, or a 401 when there is none or it has no integer id. */
export async function requireActor(): Promise<Actor> {
  const { id, name } = await workflowRuntime.getPrincipal();
  return { id, name };
}
