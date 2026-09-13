import type { Db } from "../db/index";
import type { Location } from "../db/schema";

export function createLocationRepository(db: Db) {
  return {
    async findManyByOrg(orgId: string): Promise<(Location & { inUse: boolean })[]> {
      const all = await db.location.findMany({
        where: { orgId },
        orderBy: { name: "asc" },
      });

      const [primaryInUse, backstockInUse] = await Promise.all([
        db.orgItem.findMany({
          where: { orgId, locationId: { not: null } },
          select: { locationId: true },
          distinct: ["locationId"],
        }),
        db.orgItem.findMany({
          where: { orgId, backstockLocationId: { not: null } },
          select: { backstockLocationId: true },
          distinct: ["backstockLocationId"],
        }),
      ]);

      const inUseIds = new Set([
        ...primaryInUse.map((r) => r.locationId!),
        ...backstockInUse.map((r) => r.backstockLocationId!),
      ]);

      return all.map((loc) => ({ ...loc, inUse: inUseIds.has(loc.id) }));
    },

    async findOne(id: number, orgId: string): Promise<Location | null> {
      return db.location.findFirst({ where: { id, orgId } });
    },

    async create(orgId: string, name: string): Promise<Location> {
      return db.location.create({ data: { name, orgId } });
    },

    async update(id: number, orgId: string, name: string): Promise<Location> {
      return db.location.update({ where: { id }, data: { name } });
    },

    async delete(id: number, orgId: string): Promise<void> {
      await db.location.delete({ where: { id } });
    },

    async checkInUse(id: number, orgId: string): Promise<boolean> {
      const row = await db.orgItem.findFirst({
        where: {
          orgId,
          OR: [{ locationId: id }, { backstockLocationId: id }],
        },
      });
      return row != null;
    },

    async reassign(sourceId: number, targetId: number, orgId: string): Promise<void> {
      await db.$transaction(async (tx) => {
        await tx.orgItem.updateMany({
          where: { orgId, locationId: sourceId },
          data: { locationId: targetId },
        });
        await tx.orgItem.updateMany({
          where: { orgId, backstockLocationId: sourceId },
          data: { backstockLocationId: targetId },
        });
        await tx.orgItem.updateMany({
          where: { orgId, locationId: targetId, backstockLocationId: targetId },
          data: { backstockLocationId: null },
        });
      });
    },
  };
}

export type LocationRepository = ReturnType<typeof createLocationRepository>;
