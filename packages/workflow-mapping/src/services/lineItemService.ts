import { httpError } from "@checkin/component-kit";
import { isValidGtin13 } from "@checkin/gtin";
import {
  catalogCheckReferencesSchema,
  catalogItemReferenceProposalSchema,
  catalogProvisionalItemProposalSchema,
  catalogReferenceConflictSchema,
} from "@checkin/receipt-types";
import { z } from "zod";
import { db } from "../db";
import { activeCatalogItemSchema, createdIdSchema, gtin13Schema, refCheckResultSchema } from "../contract";
import { insertAuditEvent } from "../lib/audit";
import { tryAutoProceedApply } from "../lib/auto-proceed";
import { ports, requireActor } from "../runtime";
import { loadEditableLine, updateEditableLine } from "./receiptLookup";

export const AssociateBodySchema = z.object({
  gtin13: z.string().min(1),
  // Inventory units per receipt-line unit; integer, defaults to 1 ("each").
  conversionFactor: z.number().int().positive().optional(),
});
export type AssociateBody = z.infer<typeof AssociateBodySchema>;

export const ProposeBodySchema = z.object({
  proposedName: z.string().min(1),
  proposedCategoryId: z.number().int().positive(),
  proposedSubcategoryId: z.number().int().positive(),
  proposedUsageBehavior: z.string().min(1),
  // Human-entered: inventory units per receipt-line unit. Integer, default 1.
  conversionFactor: z.number().int().positive().optional(),
});
export type ProposeBody = z.infer<typeof ProposeBodySchema>;

export function normalizeDescription(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Run a catalog call; any failure is logged and surfaces as a plain 502. */
async function viaCatalog<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error("[workflow-mapping] catalog call failed", err);
    throw httpError(502, "The catalog couldn't be reached; try again");
  }
}

export const lineItemService = {
  /**
   * CI3: optimistic association. The line is recognized with the manager's GTIN at once; a
   * reference proposal and any conflict reports go to the catalog without gating the receipt.
   * The GTIN must name an approved, non-archived catalog item: 400 if malformed, 404 if none.
   */
  async associateGtin(receiptId: number, lineId: number, body: AssociateBody): Promise<void> {
    const actor = await requireActor();
    const { gtin13 } = body;
    if (!isValidGtin13(gtin13)) {
      throw httpError(400, `"${gtin13}" is not a GTIN-13: it needs 13 digits ending in a valid check digit`);
    }
    const conversionFactor = body.conversionFactor ?? 1;
    const edit = await loadEditableLine(receiptId, lineId);
    const { received, lineItem, receipt } = edit;
    const { catalogReader, catalogSubmissions } = ports();

    const item = await viaCatalog(async () => activeCatalogItemSchema.parse(await catalogReader.getActiveItem(gtin13)));
    if (!item) throw httpError(404, `No catalog item has GTIN ${gtin13}`);

    const retailer = receipt.vendorName ?? undefined;
    const normalizedDesc =
      !lineItem.partNumber && lineItem.manufacturer && lineItem.description
        ? normalizeDescription(lineItem.description)
        : null;

    const refCheck = await viaCatalog(async () =>
      refCheckResultSchema.parse(
        await catalogReader.checkReferences(
          catalogCheckReferencesSchema.parse({
            retailer,
            partNumber: lineItem.partNumber,
            manufacturer: lineItem.manufacturer,
            description: lineItem.description,
          }),
        ),
      ),
    );

    const needsProposal =
      (lineItem.partNumber && lineItem.manufacturer && !refCheck.mfr_part.exists) ||
      (lineItem.partNumber && !refCheck.retailer_part.exists) ||
      (!lineItem.partNumber && lineItem.manufacturer && normalizedDesc && !refCheck.mfr_desc.exists);

    if (needsProposal) {
      await viaCatalog(async () =>
        createdIdSchema.parse(
          await catalogSubmissions.proposeItemReference(
            catalogItemReferenceProposalSchema.parse({
              partNumber: lineItem.partNumber ?? undefined,
              manufacturer: lineItem.manufacturer ?? undefined,
              retailer,
              description: normalizedDesc ?? undefined,
              gtin13,
              localUserId: actor.id,
              conversionFactor,
            }),
          ),
        ),
      );
    }

    const conflicts: Array<{ ref: typeof refCheck.mfr_part; fields: Record<string, string | undefined> }> = [];
    if (lineItem.partNumber && lineItem.manufacturer) {
      conflicts.push({
        ref: refCheck.mfr_part,
        fields: { manufacturer: lineItem.manufacturer, partNumber: lineItem.partNumber },
      });
    }
    if (lineItem.partNumber) {
      conflicts.push({ ref: refCheck.retailer_part, fields: { retailer, partNumber: lineItem.partNumber } });
    }
    if (!lineItem.partNumber && lineItem.manufacturer && normalizedDesc) {
      conflicts.push({
        ref: refCheck.mfr_desc,
        fields: { manufacturer: lineItem.manufacturer, description: normalizedDesc },
      });
    }
    for (const { ref, fields } of conflicts) {
      if (!ref.exists || ref.gtin13 === gtin13 || ref.id == null || ref.gtin13 == null) continue;
      const { id: itemReferenceId, gtin13: existingGtin13 } = ref;
      await viaCatalog(async () =>
        createdIdSchema.parse(
          await catalogSubmissions.reportConflict(
            catalogReferenceConflictSchema.parse({
              itemReferenceId,
              existingGtin13,
              proposedGtin13: gtin13,
              ...fields,
              receiptId: received.receiptId,
              lineItemId: lineItem.receiptLineItemId,
            }),
          ),
        ),
      );
    }

    // Manual association: the human-entered factor is authoritative; version 1.
    await updateEditableLine(edit, {
      recognitionStatus: "recognized",
      assignedGtin13: gtin13,
      provisionalItemGtin13: null,
      conversionFactor,
      conversionVersion: 1,
    }, actor);

    await insertAuditEvent(db, {
      orgId: received.orgId,
      actorUserId: actor.id,
      actorUsername: actor.name,
      eventType: "line_associated",
      receivedReceiptId: receiptId,
      lineStatusId: lineId,
      details: JSON.stringify({ gtin13 }),
    });

    await tryAutoProceedApply(receiptId, received, actor);
  },

  async proposeProvisionalItem(
    receiptId: number,
    lineId: number,
    body: ProposeBody,
  ): Promise<{ provisionalGtin13: string }> {
    const actor = await requireActor();
    const conversionFactor = body.conversionFactor ?? 1;
    const edit = await loadEditableLine(receiptId, lineId);
    const { received, lineItem, receipt } = edit;
    const { catalogSubmissions } = ports();

    const provisionalGtin13 = await viaCatalog(async () =>
      gtin13Schema.parse(await catalogSubmissions.allocateProvisionalGtin()),
    );
    await viaCatalog(() =>
      catalogSubmissions.proposeProvisionalItem(
        catalogProvisionalItemProposalSchema.parse({
          provisionalGtin13,
          proposedName: body.proposedName,
          proposedCategoryId: body.proposedCategoryId,
          proposedSubcategoryId: body.proposedSubcategoryId,
          proposedUsageBehavior: body.proposedUsageBehavior,
          localUserId: actor.id,
          partNumber: lineItem.partNumber ?? undefined,
          manufacturer: lineItem.manufacturer ?? undefined,
          retailer: receipt.vendorName ?? undefined,
          conversionFactor,
        }),
      ),
    );

    // Provisional: human-entered factor; version 1 (no catalog reference yet).
    await updateEditableLine(edit, {
      recognitionStatus: "provisional",
      assignedGtin13: null,
      provisionalItemGtin13: provisionalGtin13,
      conversionFactor,
      conversionVersion: 1,
    }, actor);

    await insertAuditEvent(db, {
      orgId: received.orgId,
      actorUserId: actor.id,
      actorUsername: actor.name,
      eventType: "line_proposed",
      receivedReceiptId: receiptId,
      lineStatusId: lineId,
      details: JSON.stringify({ provisionalGtin13, proposedName: body.proposedName }),
    });

    await tryAutoProceedApply(receiptId, received, actor);

    return { provisionalGtin13 };
  },

  async markNonInventory(receiptId: number, lineId: number): Promise<void> {
    const actor = await requireActor();
    const edit = await loadEditableLine(receiptId, lineId);
    const { received } = edit;

    await updateEditableLine(edit, { recognitionStatus: "non_inventory", assignedGtin13: null, provisionalItemGtin13: null }, actor);

    await insertAuditEvent(db, {
      orgId: received.orgId,
      actorUserId: actor.id,
      actorUsername: actor.name,
      eventType: "line_marked_non_inventory",
      receivedReceiptId: receiptId,
      lineStatusId: lineId,
    });

    await tryAutoProceedApply(receiptId, received, actor);
  },
};
