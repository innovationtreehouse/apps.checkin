// In-kind crossings (FR5). The callees (X9, X13) parse their input and assert the injected org,
// then record it; a throw tells the caller to retry. The caller wrappers (X10) parse what the
// bound port returns.
import { z } from "zod";
import { CompletedReceiptSchema, type CompletedReceipt } from "@inventory/receipt-types";
import { CatalogItemSummarySchema, InKindDonorSchema, type CatalogItemSummary, type InKindDonor } from "./contract";
import { getCatalogLookup, getOrg } from "./runtime";
import { inKindService } from "./services/inKindService";

const receiptIdSchema = z.string().min(1);

/** Built at call time: the org is only known once the host has configured the runtime. */
async function thisOrg() {
  const orgId = (await getOrg()).id;
  return z.string().refine((id) => id === orgId, { message: "orgId is not this org" });
}

async function receiptInOrg() {
  const orgId = (await getOrg()).id;
  return CompletedReceiptSchema.refine((r) => r.orgId === orgId, { message: "orgId is not this org", path: ["orgId"] }).refine(
    (r) => r.isInKind,
    { message: "not an in-kind receipt", path: ["isInKind"] },
  );
}

/** X9 callee: an in-kind receipt's money side. Idempotent on `receiptId`. */
export async function ingestInKind(receipt: CompletedReceipt): Promise<void> {
  const r = (await receiptInOrg()).parse(receipt);
  await inKindService.recordMoney(r.orgId, receiptIdSchema.parse(r.receiptId), {
    receiptTotalCents: r.receiptTotalCents,
    receiptDate: r.receiptDate,
  });
}

/** X13 callee: the donor entered at upload. Idempotent on `receiptId`; a later call replaces the donor. */
export async function recordInKindDonor(orgId: string, receiptId: string, donor: InKindDonor): Promise<void> {
  (await thisOrg()).parse(orgId);
  receiptIdSchema.parse(receiptId);
  await inKindService.recordDonor(orgId, receiptId, InKindDonorSchema.parse(donor));
}

/** X13 callee: the uploader cleared the in-kind mark. Idempotent; an unknown receipt is a no-op. */
export async function withdrawInKind(orgId: string, receiptId: string): Promise<void> {
  (await thisOrg()).parse(orgId);
  receiptIdSchema.parse(receiptId);
  await inKindService.withdraw(orgId, receiptId);
}

/** X10 caller: catalog search for the no-receipt picker. */
export async function searchCatalog(query: string): Promise<CatalogItemSummary[]> {
  return CatalogItemSummarySchema.array().parse(await getCatalogLookup().search(query));
}

/** X10 caller: one catalog item by GTIN. */
export async function getCatalogItem(gtin13: string): Promise<CatalogItemSummary | null> {
  return CatalogItemSummarySchema.nullable().parse(await getCatalogLookup().getItem(gtin13));
}
