import type { Db } from "../db/index";
import type { ReceiveQueueRepository } from "../repositories/receiveQueueRepository";
import { applyQtyChangeIn } from "./inventoryService";
import { lockOrgItemPair, lockProvisional } from "./provisionalItemService";
import { ServiceError } from "@checkin/component-kit";

export function createReceiveQueueService({
  receiveQueueRepo,
  db,
}: {
  receiveQueueRepo: ReceiveQueueRepository;
  db: Db;
}) {
  /** The error for a line the conditional claim missed: 404 if it is not this org's, else 409. */
  async function notOpen(id: number, orgId: string): Promise<never> {
    const item = await receiveQueueRepo.findOne(id, orgId);
    if (!item) throw new ServiceError(404, "Receive queue item not found");
    throw new ServiceError(409, item.cancelledAt ? "Receive queue item was cancelled" : "Receive queue item was already fulfilled");
  }

  return {
    async listQueue(orgId: string, includeClosed = false) {
      const rows = await receiveQueueRepo.findManyByOrg(orgId);
      return includeClosed ? rows : rows.filter((r) => r.fulfilledAt === null && r.cancelledAt === null);
    },

    /**
     * Receive a queued line into stock. The open→fulfilled claim and the stock add commit in one
     * transaction, and the claim is conditional, so two concurrent fulfils add the stock once.
     */
    async fulfill(id: number, orgId: string, userId: number) {
      const open = { id, orgId, fulfilledAt: null, cancelledAt: null };
      return db.$transaction(async (tx) => {
        const claimed = await tx.receiveQueue.updateMany({ where: open, data: { fulfilledAt: new Date() } });
        if (claimed.count === 0) await notOpen(id, orgId);
        const item = await tx.receiveQueue.findUniqueOrThrow({ where: { id } });

        // A provisional GTIN since resolved by the global catalog receives under its real GTIN,
        // unless a unit conflict on it is still open: then it joins the provisional stock that
        // the conflict's resolution settles. The locks order this against a merge or resolution.
        const provisional = await lockProvisional(tx, orgId, item.gtin13);
        let gtin13 = item.gtin13;
        if (provisional?.resolvedToGtin13) {
          await lockOrgItemPair(tx, orgId, item.gtin13, provisional.resolvedToGtin13);
          const openConflict = await tx.inventoryMergeConflict.findFirst({
            where: { orgId, provisionalGtin13: item.gtin13, status: "pending" },
          });
          if (!openConflict) gtin13 = provisional.resolvedToGtin13;
        }
        await applyQtyChangeIn(tx, orgId, gtin13, item.quantity, {
          userId,
          changeType: "received",
          receiptId: item.receiptId,
          conversionFactor: item.conversionFactor,
          conversionVersion: item.conversionVersion,
        });
        return item;
      });
    },

    /** Withdraw an open line. The row stays, stamped with who cancelled it, and the inventory log records it. */
    async cancel(id: number, orgId: string, userId: number, username?: string) {
      const now = new Date();
      await db.$transaction(async (tx) => {
        const cancelled = await tx.receiveQueue.updateMany({
          where: { id, orgId, fulfilledAt: null, cancelledAt: null },
          data: { cancelledAt: now, cancelledBy: userId, cancelledByUsername: username ?? null },
        });
        if (cancelled.count === 0) await notOpen(id, orgId);
        const item = await tx.receiveQueue.findUniqueOrThrow({ where: { id } });
        await tx.inventoryLog.create({
          data: {
            orgId, userId, username: username ?? null, changedAt: now, changeType: "manual",
            gtin13: item.gtin13, fieldChanged: "receiveQueue",
            valueBefore: String(item.quantity), valueAfter: "cancelled", receiptId: item.receiptId,
            rawQuantity: item.quantity, conversionFactor: item.conversionFactor, conversionVersion: item.conversionVersion,
          },
        });
      });
    },
  };
}

export type ReceiveQueueService = ReturnType<typeof createReceiveQueueService>;
