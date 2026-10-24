// In-kind donations entered without a receipt (FR5): ops picks catalog items (X10) with a quantity
// and, optionally, a suggested value each; finance sets the value when accepting. The goods load
// into inventory under `donation:<id>` (X11).
import { z } from "zod";
import { db } from "../db";
import { InKindDonorSchema, inventorySourceKey } from "../contract";
import { getCatalogLookup, getInventoryApply } from "../runtime";
import { recordDonorDataReads, recordEvent, type DonorReadContext } from "../repositories/audit";
import type { AuditContext } from "../workflows/disbursement.actor";
import { ServiceError } from "@checkin/component-kit";

export const MAX_IN_KIND_LINE_QUANTITY = 100_000;
export const MAX_IN_KIND_LINE_VALUE_CENTS = 100_000_000;
export const MAX_IN_KIND_LINES = 200;
/** A ceiling on a gift's suggested total ($1,000,000); the large-value warning is separate. */
export const MAX_IN_KIND_TOTAL_CENTS = 100_000_000;
export const MAX_IN_KIND_DESCRIPTION = 500;

export const ManualInKindInputSchema = z.object({
  donor: InKindDonorSchema,
  donationDate: z.iso.date(),
  lines: z
    .array(
      z.object({
        gtin13: z.string().min(1),
        quantity: z.number().int().positive().max(MAX_IN_KIND_LINE_QUANTITY),
        /** What was given; never the donor. */
        description: z.string().trim().max(MAX_IN_KIND_DESCRIPTION).nullable().optional(),
        /** Ops' suggestion for the line's total value, not per unit; finance decides the value. */
        suggestedValueCents: z.number().int().nonnegative().max(MAX_IN_KIND_LINE_VALUE_CENTS).nullable().optional(),
      }),
    )
    .min(1)
    .max(MAX_IN_KIND_LINES)
    .refine((lines) => lines.reduce((sum, l) => sum + (l.suggestedValueCents ?? 0), 0) <= MAX_IN_KIND_TOTAL_CENTS, {
      message: "The suggested total is over the limit",
    }),
});
export type ManualInKindInput = z.infer<typeof ManualInKindInputSchema>;

const LIST_SELECT = {
  id: true,
  donationDate: true,
  recordedByUserId: true,
  recordedByUsername: true,
  recordedAt: true,
  inventoryLoadedAt: true,
  lines: { select: { id: true, gtin13: true, description: true, quantity: true, valueCents: true, suggestedValueCents: true }, orderBy: { id: "asc" } },
} as const;

const DONOR_SELECT = { donorFirstName: true, donorLastName: true, donorCompanyName: true } as const;

export const manualInKindService = {
  /**
   * Newest first. Donor fields are selected, and each returned record's read audited, only when
   * `reader` is given: the caller passes one only for a viewer allowed to see donor identity.
   */
  async list(orgId: string, reader: DonorReadContext | null, page?: { skip: number; take: number }) {
    const rows = await db.manualInKindDonation.findMany({
      where: { orgId },
      select: reader ? { ...LIST_SELECT, ...DONOR_SELECT } : LIST_SELECT,
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      ...page,
    });
    if (reader) await recordDonorDataReads(db, orgId, "manual_in_kind", reader, rows.map((r) => String(r.id)));
    return rows;
  },

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
          lines: {
            create: lines.map((l) => ({
              gtin13: l.gtin13,
              quantity: l.quantity,
              description: l.description || null,
              suggestedValueCents: l.suggestedValueCents ?? null,
            })),
          },
        },
      });
      // Donor fields are pii; the audit payload carries counts and totals only.
      await recordEvent(tx, {
        orgId,
        entityType: "manual_in_kind",
        entityId: row.id,
        eventType: "MANUAL_IN_KIND_RECORDED",
        ...audit,
        payload: { lineCount: lines.length, suggestedTotalCents: lines.reduce((sum, l) => sum + (l.suggestedValueCents ?? 0), 0) },
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
        provisionalName: l.description ?? l.gtin13,
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
