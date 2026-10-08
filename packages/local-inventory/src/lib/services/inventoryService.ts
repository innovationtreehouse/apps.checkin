import type { Prisma } from "../../generated/prisma/client";
import type { Db } from "../db/index";
import type { InventoryRepository } from "../repositories/inventoryRepository";
import { ServiceError } from "./serviceError";

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
  const existing = await tx.orgItem.findFirst({ where: { gtin13, orgId } });
  const newQty = (existing?.existingQuantity ?? 0) + derived;

  if (existing) {
    await tx.orgItem.update({
      where: { orgGtin: { orgId, gtin13 } },
      data: { existingQuantity: newQty },
    });
  } else {
    await tx.orgItem.create({
      data: { orgId, gtin13, existingQuantity: derived, desiredQuantity: 0 },
    });
  }

  await tx.inventoryLog.create({
    data: {
      orgId,
      userId: meta.userId,
      username: meta.username ?? null,
      changedAt: new Date(),
      changeType: meta.changeType,
      gtin13,
      fieldChanged: "existingQuantity",
      valueBefore: String(existing?.existingQuantity ?? 0),
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

    async updateItem(
      orgId: string,
      gtin13: string,
      data: {
        existingQuantity?: number;
        desiredQuantity?: number;
        locationId?: number | null;
        backstockLocationId?: number | null;
      },
      userId: number,
      username?: string,
    ) {
      const existing = await inventoryRepo.findOne(orgId, gtin13);
      if (!existing) throw new ServiceError(404, "Organization item not found");

      const updates = {
        existingQuantity: data.existingQuantity !== undefined ? data.existingQuantity : existing.existingQuantity,
        desiredQuantity: data.desiredQuantity !== undefined ? data.desiredQuantity : existing.desiredQuantity,
        locationId: data.locationId !== undefined ? data.locationId : existing.locationId,
        backstockLocationId: data.backstockLocationId !== undefined ? data.backstockLocationId : existing.backstockLocationId,
      };

      const fieldMap: Array<{ field: string; oldVal: unknown; newVal: unknown }> = [
        { field: "existingQuantity", oldVal: existing.existingQuantity, newVal: updates.existingQuantity },
        { field: "desiredQuantity", oldVal: existing.desiredQuantity, newVal: updates.desiredQuantity },
        { field: "locationId", oldVal: existing.locationId, newVal: updates.locationId },
        { field: "backstockLocationId", oldVal: existing.backstockLocationId, newVal: updates.backstockLocationId },
      ];
      const changedFields = fieldMap.filter((f) => String(f.oldVal) !== String(f.newVal));

      const now = new Date();
      await db.$transaction(async (tx) => {
        await tx.orgItem.update({
          where: { orgGtin: { orgId, gtin13 } },
          data: updates,
        });
        for (const f of changedFields) {
          await tx.inventoryLog.create({
            data: {
              orgId, userId, username: username ?? null, changedAt: now, changeType: "manual", gtin13,
              fieldChanged: f.field,
              valueBefore: f.oldVal !== null && f.oldVal !== undefined ? String(f.oldVal) : null,
              valueAfter: f.newVal !== null && f.newVal !== undefined ? String(f.newVal) : null,
              receiptId: null,
            },
          });
        }
      });

      return inventoryRepo.findOneEnriched(orgId, gtin13);
    },

    async deleteItem(orgId: string, gtin13: string) {
      const existing = await inventoryRepo.findOne(orgId, gtin13);
      if (!existing) throw new ServiceError(404, "Organization item not found");
      await inventoryRepo.delete(orgId, gtin13);
    },

    async applyQtyChange(orgId: string, gtin13: string, rawQuantity: number, meta: QtyChangeMeta): Promise<number> {
      return db.$transaction((tx) => applyQtyChangeIn(tx, orgId, gtin13, rawQuantity, meta));
    },
  };
}

export type InventoryService = ReturnType<typeof createInventoryService>;
