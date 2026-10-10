import {
  inertCatalogEventSource,
  inertCatalogReader,
  inertOwnerDirectory,
  inertQbReader,
  inertQbWriter,
  inertSignoffDirectory,
  type CatalogEventSource,
  type CatalogReader,
  type ExpenseAuth,
  type ExpensePrincipal,
  type OrgIdentity,
  type OwnerDirectory,
  type QbReader,
  type QbWriter,
  type SignoffDirectory,
} from "./contract";

export interface QuickBooksPorts {
  reader: QbReader;
  writer: QbWriter;
}

export interface ExpenseConfig {
  /** Async accessor, called per request: the host may resolve the org from its own store. */
  org: () => Promise<OrgIdentity>;
  /** The session principal; routes only. In-process callers pass a principal explicitly. */
  auth?: ExpenseAuth;
  budgetOwners?: OwnerDirectory;
  /** Who may fill a sign-off seat: bucket approvers, role holders, households, membership. */
  signoff?: SignoffDirectory;
  catalog?: CatalogReader;
  catalogEvents?: CatalogEventSource;
  quickbooks?: Partial<QuickBooksPorts>;
}

export interface ExpenseRuntime {
  org: () => Promise<OrgIdentity>;
  auth: ExpenseAuth;
  budgetOwners: OwnerDirectory;
  signoff: SignoffDirectory;
  catalog: CatalogReader;
  catalogEvents: CatalogEventSource;
  quickbooks: QuickBooksPorts;
}

// On globalThis so the instrumentation chunk that configures it and the route chunks that
// read it share one runtime (and it survives dev HMR).
const globalForRuntime = globalThis as typeof globalThis & { __expenseRuntime?: ExpenseRuntime };

/** Binds the host's ports. Touches no database. Unbound ports fall back to the inert adapters. */
export function configureExpense(config: ExpenseConfig): void {
  globalForRuntime.__expenseRuntime = {
    org: config.org,
    auth: config.auth ?? { getPrincipal: async () => null },
    budgetOwners: config.budgetOwners ?? inertOwnerDirectory,
    signoff: config.signoff ?? inertSignoffDirectory,
    catalog: config.catalog ?? inertCatalogReader,
    catalogEvents: config.catalogEvents ?? inertCatalogEventSource,
    quickbooks: {
      reader: config.quickbooks?.reader ?? inertQbReader,
      writer: config.quickbooks?.writer ?? inertQbWriter,
    },
  };
}

export function getExpenseRuntime(): ExpenseRuntime {
  const runtime = globalForRuntime.__expenseRuntime;
  if (!runtime) throw new Error("configureExpense() has not been called");
  return runtime;
}

export function getOrg(): Promise<OrgIdentity> {
  return getExpenseRuntime().org();
}

/** The current request's org id, the scope of every expense row. */
export async function getOrgId(): Promise<string> {
  return (await getOrg()).id;
}

/** Callee guard: a crossing payload must carry the injected org. */
export async function assertOrg(orgId: string): Promise<void> {
  if (orgId !== (await getOrgId())) throw new Error(`orgId ${orgId} is not this org`);
}

/** The session principal. Throws if absent: host admission has already run. */
export async function getPrincipal(): Promise<ExpensePrincipal> {
  const principal = await getExpenseRuntime().auth.getPrincipal();
  if (!principal || !Number.isInteger(principal.id)) {
    throw new Error("no expense principal — host admission should have rejected this request");
  }
  return principal;
}
