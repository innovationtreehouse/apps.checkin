// In-kind crossings (FR5). The callees (X9, X13) parse their input and assert the injected org,
// then record it; a throw tells the caller to retry. The caller wrappers (X10) parse what the
// bound port returns. The no-receipt entry records a donation for the current org and principal
// and loads its goods (X11).
import { z } from "zod";
import { CompletedReceiptSchema, type CompletedReceipt } from "@checkin/receipt-types";
import { CatalogItemSummarySchema, InKindDonorSchema, type CatalogItemSummary, type InKindDonor } from "./contract";
import { db } from "./db";
import { getCatalogLookup, getOrg, getOrgId, getPrincipal } from "./runtime";
import { inKindService } from "./services/inKindService";
import { manualInKindService, type ManualInKindInput } from "./services/manualInKindService";

const receiptIdSchema = z.string().min(1);
const syncSeqSchema = z.number().int().nonnegative();

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

/** X9 callee: an in-kind receipt's money side. Written once per `receiptId`; a differing replay is raised, never merged. */
export async function ingestInKind(receipt: CompletedReceipt): Promise<void> {
  const r = (await receiptInOrg()).parse(receipt);
  await inKindService.recordMoney(r.orgId, receiptIdSchema.parse(r.receiptId), {
    receiptTotalCents: r.receiptTotalCents,
    receiptDate: r.receiptDate,
    uploadedByUserId: r.submitterId,
    lines: r.lineItems.map((l) => ({
      receiptLineItemId: l.receiptLineItemId,
      lineNumber: l.lineNumber,
      description: l.description,
      gtin13: l.gtin13 ?? null,
      quantity: l.quantity,
      valueCents: l.totalPriceCents,
    })),
  });
}

/**
 * X13 callee: the donor entered at upload. Idempotent on `receiptId`; a later call replaces the
 * donor. `seq` is the receipt's sync sequence: a call older than one already seen is ignored.
 */
export async function recordInKindDonor(orgId: string, receiptId: string, donor: InKindDonor, seq: number): Promise<void> {
  (await thisOrg()).parse(orgId);
  receiptIdSchema.parse(receiptId);
  await inKindService.recordDonor(orgId, receiptId, InKindDonorSchema.parse(donor), syncSeqSchema.parse(seq));
}

/** X13 callee: the uploader cleared the in-kind mark. Idempotent; an unknown receipt or a stale `seq` is a no-op. */
export async function withdrawInKind(orgId: string, receiptId: string, seq: number): Promise<void> {
  (await thisOrg()).parse(orgId);
  receiptIdSchema.parse(receiptId);
  await inKindService.withdraw(orgId, receiptId, syncSeqSchema.parse(seq));
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

export type GiftOutcome = "awaiting_decision" | "accepted" | "refused" | "returned";

const GIFT_OUTCOME: Readonly<Record<string, GiftOutcome>> = { ACCEPTED: "accepted", REFUSED: "refused", RETURNED: "returned" };

/** Receipt callee: finance's decision on each named receipt's in-kind gift; a receipt with no gift is left out. */
export async function giftOutcomes(receiptIds: unknown): Promise<Map<string, GiftOutcome>> {
  const ids = z.array(receiptIdSchema).parse(receiptIds);
  if (ids.length === 0) return new Map();
  const gifts = await db.inKindDonation.findMany({
    where: { orgId: await getOrgId(), receiptId: { in: ids } },
    select: { receiptId: true, decisionOutcome: true },
  });
  return new Map(gifts.map((g) => [g.receiptId, g.decisionOutcome ? (GIFT_OUTCOME[g.decisionOutcome] ?? "awaiting_decision") : "awaiting_decision"]));
}
