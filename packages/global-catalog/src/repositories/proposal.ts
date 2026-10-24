import type { PrismaClient, Prisma } from "../generated/prisma/client";

type Tx = Prisma.TransactionClient;

export function createProposalRepository(db: PrismaClient) {
  return {
    // ── Item Reference Proposals ──────────────────────────────────────────────

    findItemReferenceProposalById: (id: number) =>
      db.itemReferenceProposal.findFirst({ where: { id } }),

    createItemReferenceProposal: (data: Prisma.ItemReferenceProposalUncheckedCreateInput) =>
      db.itemReferenceProposal.create({ data }),

    /** Moves the proposal on only if it is still in `fromStatus`; returns the rows changed (0 or 1). */
    transitionItemReferenceProposal: async (tx: Tx, id: number, fromStatus: string, data: Prisma.ItemReferenceProposalUncheckedUpdateInput) =>
      (await tx.itemReferenceProposal.updateMany({ where: { id, status: fromStatus }, data })).count,

    updateManyItemReferenceProposals: (tx: Tx, where: Prisma.ItemReferenceProposalWhereInput, data: Prisma.ItemReferenceProposalUncheckedUpdateInput) =>
      tx.itemReferenceProposal.updateMany({ where, data }),

    findManyItemReferenceProposalsToSupersede: (tx: Tx, where: Prisma.ItemReferenceProposalWhereInput) =>
      tx.itemReferenceProposal.findMany({ where, select: { id: true, orgId: true } }),

    createItemReferenceProposalInTx: (tx: Tx, data: Prisma.ItemReferenceProposalUncheckedCreateInput) =>
      tx.itemReferenceProposal.create({ data }),

    countPendingItemReferenceProposals: () =>
      db.itemReferenceProposal.count({ where: { status: "pending" } }),

    async listPendingItemReferenceProposalsPaginated(page: number, limit: number) {
      const where = { status: "pending" as const };
      const [total, rows] = await Promise.all([
        db.itemReferenceProposal.count({ where }),
        db.itemReferenceProposal.findMany({
          where,
          include: { item: { select: { name: true } } },
          orderBy: { proposedAt: "asc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
      ]);
      return { total, rows };
    },

    // ── Provisional Items ─────────────────────────────────────────────────────

    findProvisionalItemById: (id: number) =>
      db.provisionalItem.findFirst({ where: { id } }),

    createProvisionalItem: (data: Prisma.ProvisionalItemUncheckedCreateInput) =>
      db.provisionalItem.create({ data }),

    /** Moves the provisional on only if it is still in `fromStatus`; returns the rows changed (0 or 1). */
    transitionProvisionalItem: async (tx: Tx, id: number, fromStatus: string, data: Prisma.ProvisionalItemUncheckedUpdateInput) =>
      (await tx.provisionalItem.updateMany({ where: { id, status: fromStatus }, data })).count,

    countPendingProvisionalItems: () =>
      db.provisionalItem.count({ where: { status: "pending" } }),

    async listProvisionalItemsPaginated(page: number, limit: number) {
      const [total, rows] = await Promise.all([
        db.provisionalItem.count(),
        db.provisionalItem.findMany({
          orderBy: { proposedAt: "asc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
      ]);
      return { total, rows };
    },

    // ── Provisional Item Mapping Log ──────────────────────────────────────────

    createProvisionalItemMappingLog: (tx: Tx, data: Prisma.ProvisionalItemMappingLogUncheckedCreateInput) =>
      tx.provisionalItemMappingLog.create({ data }),

    listProvisionalItemMappingLog: (orgId: string) =>
      db.provisionalItemMappingLog.findMany({
        where: { orgId },
        select: {
          id: true, provisionalGtin13: true, realGtin13: true,
          mappedAt: true, mappingType: true,
        },
        orderBy: { mappedAt: "asc" },
      }),
  };
}

export type ProposalRepository = ReturnType<typeof createProposalRepository>;
