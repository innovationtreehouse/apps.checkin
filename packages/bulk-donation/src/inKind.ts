// In-kind crossings (FR5). The callees (X9, X13) parse their input and assert the injected org,
// then throw NotWiredError until the in-kind domain lands; a throw tells the caller to retry.
// The caller wrappers (X10) parse what the bound port returns.
import { z } from "zod";
import { CompletedReceiptSchema, type CompletedReceipt } from "@inventory/receipt-types";
import { CatalogItemSummarySchema, InKindDonorSchema, type CatalogItemSummary, type InKindDonor } from "./contract";
import { NotWiredError, getCatalogLookup, getOrg } from "./runtime";

const receiptIdSchema = z.string().min(1);

/** Built at call time: the org is only known once the host has configured the runtime. */
async function thisOrg() {
  const orgId = (await getOrg()).id;
  return z.string().refine((id) => id === orgId, { message: "orgId is not this org" });
}

async function receiptInOrg() {
  const orgId = (await getOrg()).id;
  return CompletedReceiptSchema.refine((r) => r.orgId === orgId, { message: "orgId is not this org", path: ["orgId"] });
}

/** X9 callee: an in-kind receipt's money side. Idempotent on `receiptId`. */
export async function ingestInKind(receipt: CompletedReceipt): Promise<void> {
  (await receiptInOrg()).parse(receipt);
  throw new NotWiredError("ingestInKind (X9)");
}

/** X13 callee: the donor entered at upload. Idempotent on `receiptId`; a later call replaces the donor. */
export async function recordInKindDonor(orgId: string, receiptId: string, donor: InKindDonor): Promise<void> {
  (await thisOrg()).parse(orgId);
  receiptIdSchema.parse(receiptId);
  InKindDonorSchema.parse(donor);
  throw new NotWiredError("recordInKindDonor (X13)");
}

/** X13 callee: the uploader cleared the in-kind mark. Idempotent; an unknown receipt is a no-op. */
export async function withdrawInKind(orgId: string, receiptId: string): Promise<void> {
  (await thisOrg()).parse(orgId);
  receiptIdSchema.parse(receiptId);
  throw new NotWiredError("withdrawInKind (X13)");
}

/** X10 caller: catalog search for the no-receipt picker. */
export async function searchCatalog(query: string): Promise<CatalogItemSummary[]> {
  return CatalogItemSummarySchema.array().parse(await getCatalogLookup().search(query));
}

/** X10 caller: one catalog item by GTIN. */
export async function getCatalogItem(gtin13: string): Promise<CatalogItemSummary | null> {
  return CatalogItemSummarySchema.nullable().parse(await getCatalogLookup().getItem(gtin13));
}
