import type { Db } from "../db/index";
import type { LocationRepository } from "../repositories/locationRepository";
import { ServiceError } from "./serviceError";

export function createLocationService({
  locationRepo,
  db,
}: {
  locationRepo: LocationRepository;
  db: Db;
}) {
  return {
    async listLocations(orgId: string) {
      return locationRepo.findManyByOrg(orgId);
    },

    async createLocation(orgId: string, name: string, userId: number, username?: string) {
      const location = await locationRepo.create(orgId, name.trim());
      await db.locationLog.create({
        data: {
          orgId,
          locationId: location.id,
          userId,
          username: username ?? null,
          changedAt: new Date(),
          eventType: "created",
          nameAfter: location.name,
        },
      });
      return location;
    },

    async updateLocation(id: number, orgId: string, name: string, userId: number, username?: string) {
      const existing = await locationRepo.findOne(id, orgId);
      if (!existing) throw new ServiceError(404, "Location not found");
      const updated = await locationRepo.update(id, orgId, name.trim());
      await db.locationLog.create({
        data: {
          orgId,
          locationId: id,
          userId,
          username: username ?? null,
          changedAt: new Date(),
          eventType: "updated",
          nameBefore: existing.name,
          nameAfter: updated.name,
        },
      });
      return updated;
    },

    async deleteLocation(id: number, orgId: string, userId: number, username?: string) {
      const existing = await locationRepo.findOne(id, orgId);
      if (!existing) throw new ServiceError(404, "Location not found");
      const inUse = await locationRepo.checkInUse(id, orgId);
      if (inUse) throw new ServiceError(409, "Location is in use and cannot be deleted");
      // Log before delete so the locationId still corresponds to the record being removed
      await db.locationLog.create({
        data: {
          orgId,
          locationId: id,
          userId,
          username: username ?? null,
          changedAt: new Date(),
          eventType: "deleted",
          nameBefore: existing.name,
        },
      });
      await locationRepo.delete(id, orgId);
    },

    async reassignLocation(sourceId: number, targetId: number, orgId: string, userId: number, username?: string) {
      const source = await locationRepo.findOne(sourceId, orgId);
      if (!source) throw new ServiceError(404, "Location not found");
      const target = await locationRepo.findOne(targetId, orgId);
      if (!target) throw new ServiceError(404, "Target location not found");
      if (sourceId === targetId) throw new ServiceError(400, "targetLocationId must differ from source location");

      // Fetch affected items before the update so we know what moved.
      // backstockCleared: items where both locationId=targetId and backstockLocationId=sourceId
      // — they end up with locationId=targetId and backstockLocationId=null (net: source→null).
      const [primaryItems, backstockItems] = await Promise.all([
        db.orgItem.findMany({
          where: { orgId, locationId: sourceId },
          select: { gtin13: true },
        }),
        db.orgItem.findMany({
          where: { orgId, backstockLocationId: sourceId },
          select: { gtin13: true, locationId: true },
        }),
      ]);
      const backstockCleared = backstockItems.filter((i) => i.locationId === targetId);
      const backstockMoved = backstockItems.filter((i) => i.locationId !== targetId);

      const now = new Date();
      await db.$transaction(async (tx) => {
        await tx.orgItem.updateMany({
          where: { orgId, locationId: sourceId },
          data: { locationId: targetId },
        });
        await tx.orgItem.updateMany({
          where: { orgId, backstockLocationId: sourceId },
          data: { backstockLocationId: targetId },
        });
        // Clear backstock for items that now have the same location in both slots
        await tx.orgItem.updateMany({
          where: { orgId, locationId: targetId, backstockLocationId: targetId },
          data: { backstockLocationId: null },
        });

        // Log primary-location moves
        for (const item of primaryItems) {
          await tx.inventoryLog.create({
            data: {
              orgId,
              userId,
              username: username ?? null,
              changedAt: now,
              changeType: "manual",
              gtin13: item.gtin13,
              fieldChanged: "locationId",
              valueBefore: String(sourceId),
              valueAfter: String(targetId),
              receiptId: null,
            },
          });
        }

        // Log backstock-location moves (net: sourceId → targetId)
        for (const item of backstockMoved) {
          await tx.inventoryLog.create({
            data: {
              orgId,
              userId,
              username: username ?? null,
              changedAt: now,
              changeType: "manual",
              gtin13: item.gtin13,
              fieldChanged: "backstockLocationId",
              valueBefore: String(sourceId),
              valueAfter: String(targetId),
              receiptId: null,
            },
          });
        }

        // Log backstock clears (net: sourceId → null because primary slot is now targetId)
        for (const item of backstockCleared) {
          await tx.inventoryLog.create({
            data: {
              orgId,
              userId,
              username: username ?? null,
              changedAt: now,
              changeType: "manual",
              gtin13: item.gtin13,
              fieldChanged: "backstockLocationId",
              valueBefore: String(sourceId),
              valueAfter: null,
              receiptId: null,
            },
          });
        }

        await tx.locationLog.create({
          data: {
            orgId,
            locationId: sourceId,
            userId,
            username: username ?? null,
            changedAt: now,
            eventType: "reassigned",
            nameBefore: source.name,
            nameAfter: target.name,
          },
        });
      });
    },
  };
}

export type LocationService = ReturnType<typeof createLocationService>;
