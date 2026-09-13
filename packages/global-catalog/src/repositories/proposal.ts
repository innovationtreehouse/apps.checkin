import type { PrismaClient, Prisma } from "../generated/prisma/client";

type Tx = Prisma.TransactionClient;

export function createProposalRepository(db: PrismaClient) {
  return {
    // ── Item Reference Proposals ──────────────────────────────────────────────

    findItemReferenceProposalById: (id: number) =>
      db.itemReferenceProposal.findFirst({ where: { id } }),

    createItemReferenceProposal: (data: Prisma.ItemReferenceProposalUncheckedCreateInput) =>
      db.itemReferenceProposal.create({ data }),

    updateItemReferenceProposal: (tx: Tx, id: number, data: Prisma.ItemReferenceProposalUncheckedUpdateInput) =>
      tx.itemReferenceProposal.update({ where: { id }, data }),

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

    updateProvisionalItem: (tx: Tx, id: number, data: Prisma.ProvisionalItemUncheckedUpdateInput) =>
      tx.provisionalItem.update({ where: { id }, data }),

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
