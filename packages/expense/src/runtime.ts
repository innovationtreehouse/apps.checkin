import { defineRuntime } from "@checkin/component-kit";
import {
  inertCatalogEventSource,
  inertCatalogReader,
  inertOutbound,
  inertOwnerDirectory,
  inertPeopleDirectory,
  inertQbReader,
  inertQbRefs,
  inertQbVendors,
  inertSignoffDirectory,
  type CatalogEventSource,
  type CatalogReader,
  type ExpenseAuth,
  type ExpensePrincipal,
  type OrgIdentity,
  type Outbound,
  type OwnerDirectory,
  type PeopleDirectory,
  type QbReader,
  type QbRefs,
  type QbVendors,
  type ExpensePosting,
  type SignoffDirectory,
} from "./contract";

export interface QuickBooksPorts {
  reader: QbReader;
  refs: QbRefs;
  vendors: QbVendors;
  /** Resolved per run; null while the host has no client or payment account: nothing is posted. */
  posting: () => Promise<ExpensePosting | null>;
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
  /** Display names, for showing who a reimbursee is. */
  people?: PeopleDirectory;
  quickbooks?: Partial<QuickBooksPorts>;
  /** The host's outbound gateway; unbound, every outbound send throws. */
  outbound?: Outbound;
}

export interface ExpenseRuntime {
  org: () => Promise<OrgIdentity>;
  auth: ExpenseAuth;
  budgetOwners: OwnerDirectory;
  signoff: SignoffDirectory;
  catalog: CatalogReader;
  catalogEvents: CatalogEventSource;
  people: PeopleDirectory;
  quickbooks: QuickBooksPorts;
  outbound: Outbound;
}

export const expenseRuntime = defineRuntime<ExpenseRuntime, ExpensePrincipal>("expense");

/** Binds the host's ports. Touches no database. Unbound ports fall back to the inert adapters. */
export function configureExpense(config: ExpenseConfig): void {
  expenseRuntime.configure({
    org: config.org,
    auth: config.auth ?? { getPrincipal: async () => null },
    budgetOwners: config.budgetOwners ?? inertOwnerDirectory,
    signoff: config.signoff ?? inertSignoffDirectory,
    catalog: config.catalog ?? inertCatalogReader,
    catalogEvents: config.catalogEvents ?? inertCatalogEventSource,
    people: config.people ?? inertPeopleDirectory,
    quickbooks: {
      reader: config.quickbooks?.reader ?? inertQbReader,
      refs: config.quickbooks?.refs ?? inertQbRefs,
      vendors: config.quickbooks?.vendors ?? inertQbVendors,
      posting: config.quickbooks?.posting ?? (async () => null),
    },
    outbound: config.outbound ?? inertOutbound,
  });
}

export const getExpenseRuntime = expenseRuntime.require;

export function getOrg(): Promise<OrgIdentity> {
  return getExpenseRuntime().org();
}

/** The current request's org id, the scope of every expense row. */
export const getOrgId = expenseRuntime.getOrgId;

/** Callee guard: a crossing payload must carry the injected org. */
export const assertOrg = expenseRuntime.assertOrg;

/** The session principal. A 401 if absent: host admission has already run. */
export const getPrincipal = expenseRuntime.getPrincipal;
