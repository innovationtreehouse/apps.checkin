import { db } from "../db";
import { recordEvent } from "../repositories/audit";
import type { AuditContext } from "../workflows/disbursement.actor";
import { ServiceError } from "@checkin/component-kit";

export const commentRuleService = {
  async listCommentRules(orgId: string, page?: { skip: number; take: number }) {
    return db.transactionCommentRule.findMany({ where: { orgId }, orderBy: { id: "asc" }, ...page });
  },

  async deleteCommentRule(orgId: string, id: number, audit: AuditContext) {
    const existing = await db.transactionCommentRule.findFirst({ where: { id, orgId } });
    if (!existing) throw new ServiceError(404, "Comment rule not found");
    await db.$transaction(async (tx) => {
      await tx.transactionCommentRule.delete({ where: { id } });
      // The rule's comment is donor text; the row names the rule by id only.
      await recordEvent(tx, {
        orgId,
        entityType: "comment_rule",
        entityId: id,
        eventType: "COMMENT_RULE_DELETED",
        ...audit,
        payload: { ownerId: existing.ownerId },
      });
    });
  },
};
