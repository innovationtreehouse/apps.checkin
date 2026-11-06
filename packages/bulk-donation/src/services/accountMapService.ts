import { db } from "../db";
import { recordEvent } from "../repositories/audit";
import { ServiceError } from "@checkin/component-kit";

interface AccountMapData {
  companyName: string;
  corporatePeerCampaign: string;
  donationMethod?: string | null;
  donationType?: string | null;
  donationAccountId?: string | null;
  matchAccountId?: string | null;
}

interface AuditActor {
  userId: number;
  username: string;
  correlationId: string | null;
}

export const accountMapService = {
  async listAccountMaps(orgId: string, page?: { skip: number; take: number }) {
    return db.accountMap.findMany({ where: { orgId }, orderBy: { id: "asc" }, ...page });
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
          // The name columns hold what finance typed before rules named accounts; a new rule has none.
          donationAccount: "",
          matchAccount: "",
          feesAccount: "",
          donationAccountId: data.donationAccountId ?? null,
          matchAccountId: data.matchAccountId ?? null,
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
          donationAccountId: data.donationAccountId ?? null,
          matchAccountId: data.matchAccountId ?? null,
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
