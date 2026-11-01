import type { Prisma } from "../../generated/prisma/client";
import { isRecordNotFoundError, type Db } from "../db/index";
import type { InventoryRepository } from "../repositories/inventoryRepository";
import { ServiceError } from "@checkin/component-kit";

export type QtyChangeMeta = {
  userId: number | null;
  username?: string | null;
  changeType: "manual" | "automatic" | "received";
  receiptId: string | null;
  // Inventory units per receipt-line unit. The delta added to the live
  // total is rawQuantity * conversionFactor; raw/factor/derived are kept
  // in the audit log only. Defaults to 1 ("each") for plain deltas.
  conversionFactor?: number;
  conversionVersion?: number;
};

/** Add a quantity to an org item and log it, inside the caller's transaction. Returns the new total. */
export async function applyQtyChangeIn(
  tx: Prisma.TransactionClient,
  orgId: string,
  gtin13: string,
  rawQuantity: number,
  meta: QtyChangeMeta,
): Promise<number> {
  const conversionFactor = meta.conversionFactor ?? 1;
  const conversionVersion = meta.conversionVersion ?? 1;
  const derived = rawQuantity * conversionFactor;
  // One atomic upsert-increment, so concurrent writers to one GTIN never lose an add.
  const { existingQuantity: newQty } = await tx.orgItem.upsert({
    where: { orgGtin: { orgId, gtin13 } },
    create: { orgId, gtin13, existingQuantity: derived, desiredQuantity: 0 },
    update: { existingQuantity: { increment: derived } },
  });

  await tx.inventoryLog.create({
    data: {
      orgId,
      userId: meta.userId,
      username: meta.username ?? null,
      changedAt: new Date(),
      changeType: meta.changeType,
      gtin13,
      fieldChanged: "existingQuantity",
      valueBefore: String(newQty - derived),
      valueAfter: String(newQty),
      receiptId: meta.receiptId,
      rawQuantity,
      conversionFactor,
      conversionVersion,
    },
  });

  return newQty;
}

export function createInventoryService({
  inventoryRepo,
  db,
}: {
  inventoryRepo: InventoryRepository;
  db: Db;
}) {
  return {
    async listItems(orgId: string) {
      return inventoryRepo.findManyByOrg(orgId);
    },

    async getItem(orgId: string, gtin13: string) {
      return inventoryRepo.findOneEnriched(orgId, gtin13);
    },

    async createItem(
      orgId: string,
      data: {
        gtin13: string;
        existingQuantity?: number;
        desiredQuantity?: number;
        locationId?: number | null;
        backstockLocationId?: number | null;
      },
      userId: number,
      username?: string,
    ) {
      const existing = await inventoryRepo.findOne(orgId, data.gtin13);
      if (existing) throw new ServiceError(409, "Organization entry already exists for this GTIN-13. Use PUT to update.");

      const now = new Date();
      const exQty = data.existingQuantity ?? 0;
      const desQty = data.desiredQuantity ?? 0;

      await db.$transaction(async (tx) => {
        await tx.orgItem.create({
          data: {
            orgId,
            gtin13: data.gtin13,
            existingQuantity: exQty,
            desiredQuantity: desQty,
            locationId: data.locationId ?? null,
            backstockLocationId: data.backstockLocationId ?? null,
          },
        });
        await tx.inventoryLog.create({
          data: {
            orgId, userId, username: username ?? null, changedAt: now, changeType: "manual",
            gtin13: data.gtin13, fieldChanged: "existingQuantity",
            valueBefore: null, valueAfter: String(exQty), receiptId: null,
          },
        });
        await tx.inventoryLog.create({
          data: {
            orgId, userId, username: username ?? null, changedAt: now, changeType: "manual",
            gtin13: data.gtin13, fieldChanged: "desiredQuantity",
            valueBefore: null, valueAfter: String(desQty), receiptId: null,
          },
        });
      });

      return inventoryRepo.findOneEnriched(orgId, data.gtin13);
    },

    /**
     * Write only the fields sent, against the row locked in this transaction. Each field written
     * must carry the value the caller loaded; if it moved since, the save is refused so neither
     * the edit nor the concurrent change is lost.
     */
    async updateItem(
      orgId: string,
      gtin13: string,
      data: {
        existingQuantity?: number;
        expectedQuantity?: number;
        desiredQuantity?: number;
        expectedDesiredQuantity?: number;
        locationId?: number | null;
        expectedLocationId?: number | null;
        backstockLocationId?: number | null;
        expectedBackstockLocationId?: number | null;
      },
      userId: number,
      username?: string,
    ) {
      // Prisma skips undefined fields, so `updates` writes only what the caller sent.
      const { expectedQuantity, expectedDesiredQuantity, expectedLocationId, expectedBackstockLocationId, ...updates } = data;
      const expected = {
        existingQuantity: expectedQuantity,
        desiredQuantity: expectedDesiredQuantity,
        locationId: expectedLocationId,
        backstockLocationId: expectedBackstockLocationId,
      };
      const written = (Object.keys(updates) as Array<keyof typeof updates>).filter((field) => updates[field] !== undefined);
      const unguarded = written.find((field) => expected[field] === undefined);
      if (unguarded) throw new ServiceError(400, `${unguarded} requires the value it was loaded with`);

      const now = new Date();
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM org_items WHERE org_id = ${orgId} AND gtin13 = ${gtin13} FOR UPDATE`;
        const existing = await tx.orgItem.findFirst({ where: { orgId, gtin13 } });
        if (!existing) throw new ServiceError(404, "Organization item not found");
        const moved = written.filter((field) => existing[field] !== expected[field]);
        if (moved.includes("existingQuantity")) throw new ServiceError(409, "Stock changed since you loaded this page; recount.");
        if (moved.length > 0) throw new ServiceError(409, "This item changed since you loaded it; check its values and save again.");

        const changedFields = written.filter((field) => existing[field] !== updates[field]);
        if (changedFields.length === 0) return;

        await tx.orgItem.update({ where: { orgGtin: { orgId, gtin13 } }, data: updates });
        for (const field of changedFields) {
          const oldVal = existing[field];
          const newVal = updates[field];
          await tx.inventoryLog.create({
            data: {
              orgId, userId, username: username ?? null, changedAt: now, changeType: "manual", gtin13,
              fieldChanged: field,
              valueBefore: oldVal !== null ? String(oldVal) : null,
              valueAfter: newVal !== null ? String(newVal) : null,
              receiptId: null,
            },
          });
        }
      });

      return inventoryRepo.findOneEnriched(orgId, gtin13);
    },

    /** Remove an org item, logging the removed row and its actor in the same transaction. */
    async deleteItem(orgId: string, gtin13: string, userId: number, username?: string) {
      await db.$transaction(async (tx) => {
        let removed;
        try {
          removed = await tx.orgItem.delete({ where: { orgGtin: { orgId, gtin13 } } });
        } catch (err) {
          if (isRecordNotFoundError(err)) throw new ServiceError(404, "Organization item not found");
          throw err;
        }
        await tx.inventoryLog.create({
          data: {
            orgId, userId, username: username ?? null, changedAt: new Date(), changeType: "manual", gtin13,
            fieldChanged: "deleted",
            valueBefore: JSON.stringify({
              existingQuantity: removed.existingQuantity,
              desiredQuantity: removed.desiredQuantity,
              locationId: removed.locationId,
              backstockLocationId: removed.backstockLocationId,
            }),
            valueAfter: null,
            receiptId: null,
          },
        });
      });
    },

    async applyQtyChange(orgId: string, gtin13: string, rawQuantity: number, meta: QtyChangeMeta): Promise<number> {
      return db.$transaction((tx) => applyQtyChangeIn(tx, orgId, gtin13, rawQuantity, meta));
    },
  };
}

export type InventoryService = ReturnType<typeof createInventoryService>;
