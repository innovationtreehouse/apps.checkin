import type { PrismaClient, Prisma } from "../generated/prisma/client";

export function createConversionChallengeRepository(db: PrismaClient) {
  return {
    findById: (id: number) =>
      db.conversionChallenge.findFirst({ where: { id } }),

    findPendingByReferenceAndOrg: (itemReferenceId: number, orgId: string) =>
      db.conversionChallenge.findFirst({
        where: { itemReferenceId, orgId, status: "pending" },
      }),

    create: (data: Prisma.ConversionChallengeUncheckedCreateInput) =>
      db.conversionChallenge.create({ data }),

    update: (id: number, data: Prisma.ConversionChallengeUncheckedUpdateInput) =>
      db.conversionChallenge.update({ where: { id }, data }),

    countPending: () =>
      db.conversionChallenge.count({ where: { status: "pending" } }),

    async listPendingPaginated(page: number, limit: number) {
      const where = { status: "pending" as const };
      const [total, rows] = await Promise.all([
        db.conversionChallenge.count({ where }),
        db.conversionChallenge.findMany({
          where,
          include: {
            itemReference: {
              select: {
                partNumber: true, descriptionNormalized: true,
                manufacturer: true, retailer: true, gtin13: true,
                item: { select: { name: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
      ]);
      return { total, rows };
    },
  };
}

export type ConversionChallengeRepository = ReturnType<typeof createConversionChallengeRepository>;
