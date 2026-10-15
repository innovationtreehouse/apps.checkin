// In-kind donations entered without a receipt (FR5): ops picks catalog items (X10) with a quantity
// and value each; the goods then load into inventory under `donation:<id>` (X11).
import { z } from "zod";
import { db } from "../db";
import { InKindDonorSchema, inventorySourceKey } from "../contract";
import { getCatalogLookup, getInventoryApply } from "../runtime";
import { recordEvent } from "../repositories/audit";
import type { AuditContext } from "../workflows/disbursement.actor";
import { ServiceError } from "./serviceError";

export const MAX_IN_KIND_LINE_QUANTITY = 100_000;
export const MAX_IN_KIND_LINE_VALUE_CENTS = 100_000_000;

export const ManualInKindInputSchema = z.object({
  donor: InKindDonorSchema,
  donationDate: z.iso.date(),
  lines: z
    .array(
      z.object({
        gtin13: z.string().min(1),
        quantity: z.number().int().positive().max(MAX_IN_KIND_LINE_QUANTITY),
        /** The line's total value, not per unit. */
        valueCents: z.number().int().nonnegative().max(MAX_IN_KIND_LINE_VALUE_CENTS),
      }),
    )
    .min(1),
});
export type ManualInKindInput = z.infer<typeof ManualInKindInputSchema>;

export const manualInKindService = {
  /**
   * Record the donation, then load its goods. The record commits first, so a failed load leaves a
   * donation with inventoryLoadedAt unset for loadInventory to retry; it never re-records.
   */
  async record(orgId: string, raw: ManualInKindInput, audit: AuditContext & { actorUserId: number }) {
    const parsed = ManualInKindInputSchema.safeParse(raw);
    if (!parsed.success) throw new ServiceError(400, `Invalid in-kind donation: ${z.prettifyError(parsed.error)}`);
    const { donor, donationDate, lines } = parsed.data;

    const catalog = getCatalogLookup();
    for (const gtin13 of new Set(lines.map((l) => l.gtin13))) {
      if (!(await catalog.getItem(gtin13))) throw new ServiceError(400, `Catalog item ${gtin13} not found`);
    }

    const donation = await db.$transaction(async (tx) => {
      const row = await tx.manualInKindDonation.create({
        data: {
          orgId,
          donorFirstName: donor.firstName,
          donorLastName: donor.lastName,
          donorCompanyName: donor.companyName,
          donationDate,
          recordedByUserId: audit.actorUserId,
          recordedByUsername: audit.actorUsername ?? null,
          lines: { create: lines },
        },
      });
      // Donor fields are pii; the audit payload carries counts and totals only.
      await recordEvent(tx, {
        orgId,
        entityType: "manual_in_kind",
        entityId: row.id,
        eventType: "MANUAL_IN_KIND_RECORDED",
        ...audit,
        payload: { lineCount: lines.length, totalValueCents: lines.reduce((sum, l) => sum + l.valueCents, 0) },
      });
      return row;
    });

    let inventoryLoaded = true;
    try {
      await this.loadInventory(orgId, donation.id);
    } catch (err) {
      console.warn(`[bulk-donation] in-kind donation ${donation.id} recorded; inventory load failed`, err);
      inventoryLoaded = false;
    }
    return { id: donation.id, inventoryLoaded };
  },

  /** Load a recorded donation's goods. Safe to repeat: the callee is idempotent on `donation:<id>`. */
  async loadInventory(orgId: string, id: number): Promise<void> {
    const donation = await db.manualInKindDonation.findFirst({ where: { id, orgId }, include: { lines: true } });
    if (!donation) throw new ServiceError(404, "In-kind donation not found");
    await getInventoryApply().apply({
      receiptId: inventorySourceKey(donation.id),
      orgId,
      retailer: null,
      lineItems: donation.lines.map((l) => ({
        lineItemId: l.id,
        gtin13: l.gtin13,
        quantityDelta: l.quantity,
        isDelayed: false,
        conversionFactor: 1,
        conversionVersion: 1,
      })),
    });
    if (!donation.inventoryLoadedAt) {
      await db.manualInKindDonation.updateMany({ where: { id, inventoryLoadedAt: null }, data: { inventoryLoadedAt: new Date() } });
    }
  },
};
