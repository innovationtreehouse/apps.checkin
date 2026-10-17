import type { PrismaClient, Prisma } from "../generated/prisma/client";

const REF_SELECT = { gtin13: true, id: true, conversionFactor: true, conversionVersion: true } as const;

export function createItemReferenceRepository(db: PrismaClient) {
  return {
    // ── Item References ───────────────────────────────────────────────────────

    findById: (id: number) =>
      db.itemReference.findFirst({ where: { id } }),

    findByMfrPart: (partNumber: string, manufacturer: string) =>
      db.itemReference.findFirst({
        where: { partNumber, manufacturer, archivedAt: null },
        select: REF_SELECT,
      }),

    findByRetailerPart: (retailer: string, partNumber: string) =>
      db.itemReference.findFirst({
        where: { retailer, partNumber, archivedAt: null },
        select: REF_SELECT,
      }),

    findByMfrDesc: (descriptionNormalized: string, manufacturer: string) =>
      db.itemReference.findFirst({
        where: { descriptionNormalized, manufacturer, archivedAt: null },
        select: REF_SELECT,
      }),

    findConflictByMfrPart: (partNumber: string, manufacturer: string, excludeGtin13: string) =>
      db.itemReference.findFirst({
        where: { manufacturer, partNumber, gtin13: { not: excludeGtin13 }, archivedAt: null },
        select: { gtin13: true },
      }),

    findConflictByRetailerPart: (retailer: string, partNumber: string, excludeGtin13: string) =>
      db.itemReference.findFirst({
        where: { retailer, partNumber, gtin13: { not: excludeGtin13 }, archivedAt: null },
        select: { gtin13: true },
      }),

    findConflictByMfrDesc: (descriptionNormalized: string, manufacturer: string, excludeGtin13: string) =>
      db.itemReference.findFirst({
        where: { manufacturer, descriptionNormalized, gtin13: { not: excludeGtin13 }, archivedAt: null },
        select: { gtin13: true },
      }),

    listByGtin13: (gtin13: string) =>
      db.itemReference.findMany({
        where: { gtin13, archivedAt: null },
        orderBy: { id: "asc" },
      }),

    async listPaginated(params: {
      where: Prisma.ItemReferenceWhereInput;
      orderBy: Prisma.ItemReferenceOrderByWithRelationInput[];
      page: number;
      limit: number;
    }) {
      const { where, orderBy, page, limit } = params;
      const [total, rows] = await Promise.all([
        db.itemReference.count({ where }),
        db.itemReference.findMany({
          where,
          include: { item: { select: { name: true } } },
          orderBy,
          take: limit,
          skip: (page - 1) * limit,
        }),
      ]);
      return { total, rows };
    },

    createItemReference: (data: Prisma.ItemReferenceUncheckedCreateInput) =>
      db.itemReference.create({ data }),

    updateItemReference: (id: number, data: Prisma.ItemReferenceUncheckedUpdateInput) =>
      db.itemReference.update({ where: { id }, data }),

    listItemReferencesForAudit: () =>
      db.itemReference.findMany({
        select: {
          id: true, gtin13: true, manufacturer: true, retailer: true, partNumber: true,
          createdAt: true, createdByUserId: true, createdByUsername: true,
          updatedAt: true, updatedByUserId: true, updatedByUsername: true, archivedAt: true,
        },
        orderBy: { updatedAt: "asc" },
      }),

    // ── Reference Conflicts ───────────────────────────────────────────────────

    findConflictById: (id: number) =>
      db.referenceConflict.findFirst({ where: { id } }),

    createReferenceConflict: (data: Prisma.ReferenceConflictUncheckedCreateInput) =>
      db.referenceConflict.upsert({
        where: {
          itemReferenceId_receiptId_lineItemId: {
            itemReferenceId: data.itemReferenceId as number,
            receiptId: data.receiptId as string,
            lineItemId: data.lineItemId as number,
          },
        },
        update: {},
        create: data,
      }),

    updateReferenceConflict: (id: number, data: Prisma.ReferenceConflictUncheckedUpdateInput) =>
      db.referenceConflict.update({ where: { id }, data }),

    countUnresolvedConflicts: () =>
      db.referenceConflict.count({ where: { resolvedAt: null } }),

    async listUnresolvedConflictsPaginated(page: number, limit: number) {
      const where = { resolvedAt: null };
      const [total, conflicts] = await Promise.all([
        db.referenceConflict.count({ where }),
        db.referenceConflict.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
      ]);
      return { total, conflicts };
    },
  };
}

export type ItemReferenceRepository = ReturnType<typeof createItemReferenceRepository>;
