import { db } from "../db";
import { recordDonorDataRead, type DonorReadContext } from "../repositories/audit";
import { ServiceError } from "./serviceError";

export const commentRuleService = {
  async listCommentRules(orgId: string, reader: DonorReadContext) {
    const rows = await db.transactionCommentRule.findMany({ where: { orgId }, orderBy: { id: "asc" } });
    await recordDonorDataRead(db, orgId, "comment_rule", reader, { count: rows.length });
    return rows;
  },

  async deleteCommentRule(orgId: string, id: number) {
    const existing = await db.transactionCommentRule.findFirst({ where: { id, orgId } });
    if (!existing) throw new ServiceError(404, "Comment rule not found");
    await db.transactionCommentRule.delete({ where: { id } });
  },
};
