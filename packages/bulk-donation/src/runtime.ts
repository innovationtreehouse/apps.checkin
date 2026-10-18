import { defineRuntime, NotWiredError } from "@checkin/component-kit";
import type {
  BulkDonationConfig,
  BulkDonationPrincipal,
  CatalogLookup,
  DonationQbPosting,
  InKindCapital,
  InKindDirectory,
  InventoryApply,
  OrgIdentity,
  OwnerDirectory,
} from "./contract";

const INERT_OWNERS: OwnerDirectory = { list: async () => [] };
const INERT_CATALOG: CatalogLookup = { search: async () => [], getItem: async () => null };
const INERT_INVENTORY: InventoryApply = {
  apply: async () => {
    throw new NotWiredError("InventoryApply (X11)");
  },
};

/** Nobody holds a role or is conflicted, so nobody can decide a gift. */
const INERT_IN_KIND: InKindDirectory = {
  financeHolders: async () => [],
  boardMembers: async () => [],
  householdsOf: async (ids) => new Map(ids.map((id) => [id, [id]])),
  householdsSharingSurname: async (checks) => checks.map(() => false),
  bucketsApprovedBy: async () => [],
  largeValueCents: async () => 50_000,
};

/** Unbound, no line goes to capital review and none waits on it. */
const INERT_CAPITAL: InKindCapital = { submit: async () => {}, awaitingReview: async () => [] };

export { NotWiredError };

export const bulkDonationRuntime = defineRuntime<BulkDonationConfig, BulkDonationPrincipal>("bulk-donation");
const requireRuntime = bulkDonationRuntime.require;

export const configureBulkDonation = bulkDonationRuntime.configure;

/** The acting host user. A 401 if absent: host admission runs before any route body. */
export const getPrincipal = bulkDonationRuntime.getPrincipal;

/** The current request's org id, the scope of every donation row. */
export const getOrgId = bulkDonationRuntime.getOrgId;

export const assertOrg = bulkDonationRuntime.assertOrg;

export function getOrg(): Promise<OrgIdentity> {
  return requireRuntime().org();
}

export function getOwnerDirectory(): OwnerDirectory {
  return requireRuntime().owners ?? INERT_OWNERS;
}

export function getCatalogLookup(): CatalogLookup {
  return requireRuntime().catalog ?? INERT_CATALOG;
}

export function getInKindDirectory(): InKindDirectory {
  return requireRuntime().inKind ?? INERT_IN_KIND;
}

export function getInKindCapital(): InKindCapital {
  return requireRuntime().capital ?? INERT_CAPITAL;
}

export function getInventoryApply(): InventoryApply {
  return requireRuntime().inventory ?? INERT_INVENTORY;
}

/** The QuickBooks posting binding; undefined where QuickBooks is not wired, and the drain answers "unbound". */
export function getQbPosting(): DonationQbPosting | undefined {
  return requireRuntime().qb;
}

/** Deposits another lane holds; empty while that port is unbound. */
export async function otherLaneClaimedDepositIds(orgId: string): Promise<string[]> {
  return (await requireRuntime().otherLaneClaims?.claimedDepositIds(orgId)) ?? [];
}
