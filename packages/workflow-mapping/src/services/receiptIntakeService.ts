import { isNotWired, kindOf } from "@checkin/component-kit";
import { CompletedReceiptSchema, type CompletedReceiptLineItem } from "@checkin/receipt-types";
import type { z } from "zod";
import { db, isUniqueConstraintError } from "../db";
import type { ReceivedReceipt, ReceivedReceiptState } from "../db/schema";
import { executePushAndSettle } from "../lib/apply-receipt";
import { insertAuditEvent } from "../lib/audit";
import { catalogLookupResultSchema, type CatalogLookupResult } from "../contract";
import { assertOrg, getOrgId, ports } from "../runtime";
import { initialReceiptState } from "../workflows/workflow-mapping.machine";

export type Recognized = Map<number, { gtin13: string; conversionFactor: number; conversionVersion: number }>;

const CATALOG_NOT_CONNECTED = "catalog not connected";

/** What one matching attempt did: it ran (an unbound catalog says so in `note`), or the catalog was unavailable. */
export type Matching = { ran: true; recognized: Recognized; note: string | null } | { ran: false; err: unknown };

/** Matches lines against the catalog. A system or connection failure is `ran: false`; a settings failure or a bug throws. */
export async function matchLines(lineItems: CompletedReceiptLineItem[], retailer: string | null): Promise<Matching> {
  const recognized: Recognized = new Map();
  if (!retailer || lineItems.length === 0) return { ran: true, recognized, note: null };

  const lookups = lineItems.map((li, idx) => ({
    index: idx,
    partNumber: li.partNumber,
    manufacturer: li.manufacturer,
    description: li.description,
  }));

  let results: CatalogLookupResult[];
  try {
    results = catalogLookupResultSchema.array().parse(await ports().catalogReader.lookupItems(retailer, lookups));
  } catch (err) {
    if (isNotWired(err)) return { ran: true, recognized, note: CATALOG_NOT_CONNECTED };
    const kind = kindOf(err);
    if (kind === "system" || kind === "connection") return { ran: false, err };
    throw err;
  }
  for (const result of results) {
    const li = lineItems[result.index];
    if (result.gtin13 && li) {
      recognized.set(li.receiptLineItemId, {
        gtin13: result.gtin13,
        // Auto-recognized lines inherit the matched reference's factor.
        conversionFactor: result.conversionFactor,
        conversionVersion: result.conversionVersion,
      });
    }
  }
  return { ran: true, recognized, note: null };
}

/** Matching on arrival. A bug leaves every line unrecognized, as if nothing matched; a settings failure throws, so the sender retries. */
async function matchOnArrival(lineItems: CompletedReceiptLineItem[], retailer: string | null): Promise<Matching> {
  try {
    return await matchLines(lineItems, retailer);
  } catch (err) {
    if (kindOf(err) === "settings") throw err;
    console.warn("[workflow-mapping/intake] catalog lookup failed (non-fatal):", err);
    return { ran: true, recognized: new Map(), note: null };
  }
}

export interface IngestResult {
  id: number;
  state: ReceivedReceiptState;
  created: boolean;
}

/**
 * S1 callee: deliver a finished receipt. Idempotent on `receiptId` — a replay returns the stored
 * `{ id, state }` with `created: false`, even if the body differs. Throws only on an invalid
 * payload, an org mismatch, a database failure, or a catalog settings failure; a failed push is
 * recorded as `apply_failed`. An unavailable catalog saves the receipt with matching pending.
 */
export async function ingestReceipt(input: z.input<typeof CompletedReceiptSchema>): Promise<IngestResult> {
  const receipt = CompletedReceiptSchema.parse(input);
  await assertOrg(receipt.orgId);
  const orgId = await getOrgId();

  const existing = await db.receivedReceipt.findUnique({ where: { receiptId: receipt.receiptId } });
  if (existing) return { id: existing.id, state: existing.state as ReceivedReceiptState, created: false };

  const matching = await matchOnArrival(receipt.lineItems, receipt.vendorName);
  const newlyRecognized: Recognized = matching.ran ? matching.recognized : new Map();
  const hasUnrecognized = receipt.lineItems.some((li) => !newlyRecognized.has(li.receiptLineItemId));
  const initialState = initialReceiptState(hasUnrecognized);

  let inserted: ReceivedReceipt;
  try {
    // One transaction, so a failed write leaves no line-less receipt for a retry to "replay".
    inserted = await db.$transaction(async (tx) => {
      const row = await tx.receivedReceipt.create({
        data: {
          orgId,
          receiptId: receipt.receiptId,
          state: initialState,
          receiptJson: JSON.stringify(receipt),
          matchingPendingSince: matching.ran ? null : new Date(),
        },
      });
      await tx.receivedReceiptLineStatus.createMany({
        data: receipt.lineItems.map((li) => {
          const resolved = newlyRecognized.get(li.receiptLineItemId);
          return {
            receivedReceiptId: row.id,
            receiptLineItemId: li.receiptLineItemId,
            recognitionStatus: resolved ? "recognized" : "unrecognized",
            assignedGtin13: resolved?.gtin13 ?? null,
            conversionFactor: resolved?.conversionFactor ?? 1,
            conversionVersion: resolved?.conversionVersion ?? 1,
          };
        }),
      });
      await insertAuditEvent(tx, {
        orgId,
        actorUserId: null,
        eventType: "receipt_created",
        receivedReceiptId: row.id,
        toState: initialState,
        details: matching.ran ? matching.note : null,
      });
      if (!matching.ran) {
        await insertAuditEvent(tx, { orgId, actorUserId: null, eventType: "matching_deferred", receivedReceiptId: row.id });
      }
      return row;
    });
  } catch (err) {
    // A concurrent first delivery won the unique receiptId: answer as a replay.
    if (!isUniqueConstraintError(err)) throw err;
    const winner = await db.receivedReceipt.findUnique({ where: { receiptId: receipt.receiptId } });
    if (!winner) throw err;
    return { id: winner.id, state: winner.state as ReceivedReceiptState, created: false };
  }

  if (initialState === "applying") {
    const result = await executePushAndSettle(inserted.id, inserted, null);
    return { id: inserted.id, state: result?.state ?? "applying", created: true };
  }

  return { id: inserted.id, state: initialState, created: true };
}
