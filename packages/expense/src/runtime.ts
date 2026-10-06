import {
  inertCatalogEventSource,
  inertCatalogReader,
  inertOwnerDirectory,
  inertQbReader,
  inertQbWriter,
  inertSignoffDirectory,
  type CatalogEventSource,
  type CatalogReader,
  type OrgIdentity,
  type OwnerDirectory,
  type QbReader,
  type QbWriter,
  type SignoffDirectory,
} from "./contract";

export interface ExpenseConfig {
  /** Accessor, so a multi-org host can resolve the org per request without a library change. */
  org: () => OrgIdentity;
  owners?: OwnerDirectory;
  signoff?: SignoffDirectory;
  catalog?: CatalogReader;
  catalogEvents?: CatalogEventSource;
  qbReader?: QbReader;
  qbWriter?: QbWriter;
}

export type ExpenseRuntime = Required<ExpenseConfig>;

// ponytail: one runtime per process, set once at app boot.
let runtime: ExpenseRuntime | null = null;

/** Binds the host's ports. Touches no database. Unbound ports fall back to the inert adapters. */
export function configureExpense(config: ExpenseConfig): void {
  runtime = {
    org: config.org,
    owners: config.owners ?? inertOwnerDirectory,
    signoff: config.signoff ?? inertSignoffDirectory,
    catalog: config.catalog ?? inertCatalogReader,
    catalogEvents: config.catalogEvents ?? inertCatalogEventSource,
    qbReader: config.qbReader ?? inertQbReader,
    qbWriter: config.qbWriter ?? inertQbWriter,
  };
}

export function getExpenseRuntime(): ExpenseRuntime {
  if (!runtime) throw new Error("configureExpense() has not been called");
  return runtime;
}

export function getOrg(): OrgIdentity {
  return getExpenseRuntime().org();
}

/** Callee guard: a crossing payload must carry the injected org. */
export function assertOrg(orgId: string): void {
  if (orgId !== getOrg().id) throw new Error(`orgId ${orgId} is not this org`);
}
