import { defineRuntime, type OnFailure } from "@checkin/component-kit";
import {
  inertCatalogEventSource,
  inertCatalogReader,
  inertOutbound,
  inertOwnerDirectory,
  inertPeopleDirectory,
  inertQbAccounts,
  inertQbReader,
  inertQbRefs,
  inertQbVendors,
  inertSignoffDirectory,
  type CatalogEventSource,
  type CatalogReader,
  type ExpenseAlerts,
  type OrgIdentity,
  type OutcomeMail,
  type Outbound,
  type OwnerDirectory,
  type PeopleDirectory,
  type QbReader,
  type QbRefs,
  type QbVendors,
  type ExpensePosting,
  type SignoffDirectory,
} from "./contract";
import type { QboAccountList } from "@checkin/quickbooks";

export interface QuickBooksPorts {
  reader: QbReader;
  refs: QbRefs;
  vendors: QbVendors;
  /** QuickBooks' live account list, read when finance adds or changes an expense account. */
  accounts: QboAccountList;
  /** Resolved per run; null while the host has no client or payment account: nothing is posted. */
  posting: () => Promise<ExpensePosting | null>;
}

export interface ExpenseConfig {
  /** Async accessor, called per request: the host may resolve the org from its own store. */
  org: () => Promise<OrgIdentity>;
  onFailure?: OnFailure;
  budgetOwners?: OwnerDirectory;
  /** Who may fill a sign-off seat: bucket approvers, role holders, households, membership. */
  signoff?: SignoffDirectory;
  catalog?: CatalogReader;
  catalogEvents?: CatalogEventSource;
  alerts?: ExpenseAlerts;
  /** Display names, for showing who a reimbursee is. */
  people?: PeopleDirectory;
  quickbooks?: Partial<QuickBooksPorts>;
  /** The host's outbound gateway; unbound, every outbound send throws. */
  outbound?: Outbound;
  /** Unset means outcome emails wait unsent. */
  outcomeMail?: OutcomeMail;
}

export interface ExpenseRuntime {
  org: () => Promise<OrgIdentity>;
  onFailure?: OnFailure;
  budgetOwners: OwnerDirectory;
  signoff: SignoffDirectory;
  catalog: CatalogReader;
  catalogEvents: CatalogEventSource;
  alerts?: ExpenseAlerts;
  people: PeopleDirectory;
  quickbooks: QuickBooksPorts;
  outbound: Outbound;
  outcomeMail?: OutcomeMail;
}

export const expenseRuntime = defineRuntime<ExpenseRuntime, { id: number }>("expense");

/** Binds the host's ports. Touches no database. Unbound ports fall back to the inert adapters. */
export function configureExpense(config: ExpenseConfig): void {
  expenseRuntime.configure({
    org: config.org,
    onFailure: config.onFailure,
    budgetOwners: config.budgetOwners ?? inertOwnerDirectory,
    signoff: config.signoff ?? inertSignoffDirectory,
    catalog: config.catalog ?? inertCatalogReader,
    catalogEvents: config.catalogEvents ?? inertCatalogEventSource,
    alerts: config.alerts,
    people: config.people ?? inertPeopleDirectory,
    quickbooks: {
      reader: config.quickbooks?.reader ?? inertQbReader,
      refs: config.quickbooks?.refs ?? inertQbRefs,
      vendors: config.quickbooks?.vendors ?? inertQbVendors,
      accounts: config.quickbooks?.accounts ?? inertQbAccounts,
      posting: config.quickbooks?.posting ?? (async () => null),
    },
    outbound: config.outbound ?? inertOutbound,
    outcomeMail: config.outcomeMail,
  });
}

export const getExpenseRuntime = expenseRuntime.require;

/** The current request's org id, the scope of every expense row. */
export const getOrgId = expenseRuntime.getOrgId;

/** Callee guard: a crossing payload must carry the injected org. */
export const assertOrg = expenseRuntime.assertOrg;
