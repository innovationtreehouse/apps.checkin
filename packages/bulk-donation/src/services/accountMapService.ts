import { db } from "../db";
import { recordEvent } from "../repositories/audit";
import { ServiceError } from "./serviceError";

interface AccountMapData {
  companyName: string;
  corporatePeerCampaign: string;
  donationMethod?: string | null;
  donationType?: string | null;
  donationAccount: string;
  matchAccount: string;
  feesAccount: string;
}

interface AuditActor {
  userId: number;
  username: string;
  correlationId: string | null;
}

export const accountMapService = {
  async listAccountMaps(orgId: string) {
    return db.accountMap.findMany({ where: { orgId }, orderBy: { id: "asc" } });
  },

  async createAccountMap(orgId: string, data: AccountMapData, actor: AuditActor) {
    return db.$transaction(async (tx) => {
      const created = await tx.accountMap.create({
        data: {
          orgId,
          companyName: data.companyName,
          corporatePeerCampaign: data.corporatePeerCampaign,
          donationMethod: data.donationMethod ?? null,
          donationType: data.donationType ?? null,
          donationAccount: data.donationAccount,
          matchAccount: data.matchAccount,
          feesAccount: data.feesAccount,
        },
      });

      await recordEvent(tx, {
        orgId,
        entityType: "account_map",
        entityId: created.id,
        eventType: "ACCOUNT_MAP_CREATED",
        actorUserId: actor.userId,
        actorUsername: actor.username,
        correlationId: actor.correlationId,
        payload: created,
      });

      return created;
    });
  },

  async updateAccountMap(orgId: string, id: number, data: AccountMapData, actor: AuditActor) {
    return db.$transaction(async (tx) => {
      const before = await tx.accountMap.findFirst({ where: { id, orgId } });
      if (!before) throw new ServiceError(404, "Account map rule not found");

      const row = await tx.accountMap.update({
        where: { id },
        data: {
          companyName: data.companyName,
          corporatePeerCampaign: data.corporatePeerCampaign,
          donationMethod: data.donationMethod ?? null,
          donationType: data.donationType ?? null,
          donationAccount: data.donationAccount,
          matchAccount: data.matchAccount,
          feesAccount: data.feesAccount,
        },
      });

      await recordEvent(tx, {
        orgId,
        entityType: "account_map",
        entityId: id,
        eventType: "ACCOUNT_MAP_UPDATED",
        actorUserId: actor.userId,
        actorUsername: actor.username,
        correlationId: actor.correlationId,
        payload: { before, after: row },
      });

      return row;
    });
  },

  async deleteAccountMap(orgId: string, id: number, actor: AuditActor) {
    return db.$transaction(async (tx) => {
      const row = await tx.accountMap.findFirst({ where: { id, orgId } });
      if (!row) throw new ServiceError(404, "Account map rule not found");

      await tx.accountMap.delete({ where: { id } });

      await recordEvent(tx, {
        orgId,
        entityType: "account_map",
        entityId: id,
        eventType: "ACCOUNT_MAP_DELETED",
        actorUserId: actor.userId,
        actorUsername: actor.username,
        correlationId: actor.correlationId,
        payload: row,
      });

      return row;
    });
  },
};
