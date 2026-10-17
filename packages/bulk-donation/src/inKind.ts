// In-kind crossings (FR5). The callees (X9, X13) parse their input and assert the injected org,
// then record it; a throw tells the caller to retry. The caller wrappers (X10) parse what the
// bound port returns. The no-receipt entry records a donation for the current org and principal
// and loads its goods (X11).
import { z } from "zod";
import { CompletedReceiptSchema, type CompletedReceipt } from "@checkin/receipt-types";
import { CatalogItemSummarySchema, InKindDonorSchema, type CatalogItemSummary, type InKindDonor } from "./contract";
import { db } from "./db";
import { recordDonorDataReads, type DonorReadContext } from "./repositories/audit";
import { getCatalogLookup, getOrg, getOrgId, getPrincipal } from "./runtime";
import { inKindService } from "./services/inKindService";
import { manualInKindService, type ManualInKindInput } from "./services/manualInKindService";

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

/** The host showed these in-kind receipts with their donor names: one donor-read audit row per receipt. */
export async function recordReceiptDonorReads(reader: DonorReadContext, receiptIds: string[]): Promise<void> {
  await recordDonorDataReads(db, await getOrgId(), "in_kind", reader, receiptIdSchema.array().parse(receiptIds));
}

/** X10 caller: catalog search for the no-receipt picker. */
export async function searchCatalog(query: string): Promise<CatalogItemSummary[]> {
  return CatalogItemSummarySchema.array().parse(await getCatalogLookup().search(query));
}

/** X10 caller: one catalog item by GTIN. */
export async function getCatalogItem(gtin13: string): Promise<CatalogItemSummary | null> {
  return CatalogItemSummarySchema.nullable().parse(await getCatalogLookup().getItem(gtin13));
}

/** No-receipt entry: record an in-kind donation picked from the catalog, then load its goods. */
export async function recordInKindWithoutReceipt(input: ManualInKindInput): Promise<{ id: number; inventoryLoaded: boolean }> {
  const principal = await getPrincipal();
  return manualInKindService.record(await getOrgId(), input, { actorUserId: principal.id, actorUsername: principal.name });
}

/** Retry the inventory load for a no-receipt donation whose first load failed. */
export async function loadInKindInventory(id: number): Promise<void> {
  await manualInKindService.loadInventory(await getOrgId(), id);
}
