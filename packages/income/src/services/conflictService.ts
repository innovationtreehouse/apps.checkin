import { db } from "../db";
import { createPayoutRepository } from "../repositories/payout";
import { ShopifyPayoutPayloadSchema } from "../lib/schemas";
import { createPayoutFromRow } from "../lib/payout-write";
import { recordAudit } from "../lib/audit";
import { ServiceError } from "./serviceError";

const repo = createPayoutRepository(db);

export const conflictService = {
  async listPendingConflicts(orgId: string) {
    return repo.listPendingConflicts(orgId);
  },

  async resolveConflict(
    orgId: string,
    conflictId: number,
    action: "accept" | "reject",
    reason: string | null,
    userId: number,
    correlationId: string,
    username?: string,
  ) {
    return db.$transaction(async (tx) => {
      const conflict = await tx.payoutConflict.findUnique({ where: { id: conflictId } });
      if (!conflict) throw new ServiceError(404, "Not found");
      if (conflict.orgId !== orgId) throw new ServiceError(404, "Not found");
      if (conflict.status !== "pending") throw new ServiceError(409, "Conflict already resolved");

      if (action === "accept") {
        const parsed = ShopifyPayoutPayloadSchema.safeParse(JSON.parse(conflict.incomingPayload));
        if (!parsed.success) {
          throw new ServiceError(422, `invalid stored payload for conflict ${conflictId}`);
        }
        const importId = await createPayoutFromRow(tx, orgId, parsed.data, conflict.incomingPayload);
        await recordAudit(tx, {
          orgId,
          actorUserId: userId,
          actorUsername: username,
          action: "conflict.accepted",
          entityType: "payout",
          entityId: importId,
          after: parsed.data,
          reason,
          correlationId,
        });
      } else {
        await recordAudit(tx, {
          orgId,
          actorUserId: userId,
          actorUsername: username,
          action: "conflict.rejected",
          entityType: "payout_conflict",
          entityId: conflictId,
          reason,
          correlationId,
        });
      }

      await tx.payoutConflict.update({
        where: { id: conflictId },
        data: {
          status: action === "accept" ? "accepted" : "rejected",
          resolvedAt: new Date(),
          resolvedByUserId: userId,
        },
      });
    });
  },
};
