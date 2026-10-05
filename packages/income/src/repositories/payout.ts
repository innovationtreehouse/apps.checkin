import type { PrismaClient } from "../generated/prisma/client";
import type { NewPayoutImport, NewPayout } from "../db/schema";

export function createPayoutRepository(db: PrismaClient) {
  return {
    async listPayouts(orgId: string, page: number, pageSize: number) {
      const offset = (page - 1) * pageSize;
      const rows = await db.payout.findMany({
        where: { orgId },
        include: { payoutImport: { select: { importedAt: true } } },
        orderBy: { payoutDate: "desc" },
        skip: offset,
        take: pageSize,
      });
      return rows.map((r) => ({
        id: r.id,
        payoutDate: r.payoutDate,
        status: r.status,
        totalCents: r.totalCents,
        currency: r.currency,
        importedAt: r.payoutImport.importedAt,
      }));
    },

    async countPayouts(orgId: string) {
      const total = await db.payout.count({ where: { orgId } });
      return [{ total }];
    },

    async findPayoutById(orgId: string, id: number) {
      const r = await db.payout.findFirst({
        where: { orgId, id },
        include: { payoutImport: { select: { payload: true, importedAt: true } } },
      });
      if (!r) return [];
      return [{
        id: r.id,
        orgId: r.orgId,
        shopifyPayoutId: r.shopifyPayoutId,
        payoutDate: r.payoutDate,
        status: r.status,
        chargesCents: r.chargesCents,
        refundsCents: r.refundsCents,
        adjustmentsCents: r.adjustmentsCents,
        marketplaceSalesTaxCents: r.marketplaceSalesTaxCents,
        advancesCents: r.advancesCents,
        reservedFundsCents: r.reservedFundsCents,
        feesCents: r.feesCents,
        retriedAmountCents: r.retriedAmountCents,
        totalCents: r.totalCents,
        currency: r.currency,
        bankReference: r.bankReference,
        payload: r.payoutImport.payload,
        importedAt: r.payoutImport.importedAt,
      }];
    },

    async findDetailBlobByPayoutId(orgId: string, shopifyPayoutId: string) {
      const r = await db.shopifyPayoutDetailBlob.findFirst({
        where: { orgId, shopifyPayoutId },
      });
      return r ? [r] : [];
    },

    listLineItemsByPayoutId(orgId: string, shopifyPayoutId: string) {
      return db.shopifyPayoutLineItem.findMany({
        where: { orgId, shopifyPayoutId },
      });
    },

    async listPendingConflicts(orgId: string) {
      const rows = await db.payoutConflict.findMany({
        where: { orgId, status: "pending" },
        include: { payoutImport: { select: { payload: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        incomingPayload: r.incomingPayload,
        existingImportId: r.existingImportId,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
        existingPayload: r.payoutImport.payload,
      }));
    },

    async findConflictById(id: number) {
      const r = await db.payoutConflict.findUnique({ where: { id } });
      return r ? [r] : [];
    },

    resolveConflict(id: number, status: "accepted" | "rejected", resolvedByUserId: number) {
      return db.payoutConflict.update({
        where: { id },
        data: { status, resolvedAt: new Date(), resolvedByUserId },
      });
    },

    async insertImport(values: NewPayoutImport) {
      const row = await db.payoutImport.create({ data: values });
      return [row];
    },

    insertPayout(values: NewPayout) {
      return db.payout.create({ data: values });
    },

    listImportFiles(orgId: string) {
      return db.payoutImportFile.findMany({
        where: { orgId },
        orderBy: { uploadedAt: "desc" },
      });
    },
  };
}

export type PayoutRepository = ReturnType<typeof createPayoutRepository>;
