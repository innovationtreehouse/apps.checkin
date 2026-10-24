/** Finance curation: comment rules (read + delete) and the GL account map. */
import { mapServiceErrors, parseBody, parseId } from "@checkin/component-kit";
import { z } from "zod";
import { accountMapService } from "../services/accountMapService";
import { commentRuleService } from "../services/commentRuleService";
import { getOrgId } from "../runtime";
import type { DonationRouteHandler } from "../contract";
import { auditContext, donorReader, pageArgs } from "./_shared";

async function actor(req: Request): Promise<{ userId: number; username: string; correlationId: string | null }> {
  const audit = await auditContext(req);
  return { userId: audit.actorUserId, username: audit.actorUsername, correlationId: audit.correlationId ?? null };
}

const required = (label: string) => z.string().trim().min(1, `${label} is required`);
const optional = z.string().trim().nullish().transform((s) => (s ? s : null));

const accountMapSchema = z.object({
  companyName: required("companyName"),
  corporatePeerCampaign: required("corporatePeerCampaign"),
  donationMethod: optional,
  donationType: optional,
  donationAccount: required("donationAccount"),
  matchAccount: required("matchAccount"),
  feesAccount: required("feesAccount"),
});

export const listCommentRules: DonationRouteHandler = async ({ req }) => {
  const reader = await donorReader(req, "GET /api/donations/comment-rules");
  return { TransactionCommentRule: await commentRuleService.listCommentRules(await getOrgId(), reader, pageArgs(req)) };
};

export const deleteCommentRule: DonationRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  const audit = await auditContext(req);
  await mapServiceErrors(() => commentRuleService.deleteCommentRule(orgId, id, audit));
  return {};
};

export const listAccountMap: DonationRouteHandler = async ({ req }) => ({
  AccountMap: await accountMapService.listAccountMaps(await getOrgId(), pageArgs(req)),
});

export const createAccountMap: DonationRouteHandler = async ({ req }) => {
  const data = await parseBody(req, accountMapSchema);
  const audit = await actor(req);
  return { AccountMap: await accountMapService.createAccountMap(await getOrgId(), data, audit) };
};

export const updateAccountMap: DonationRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const data = await parseBody(req, accountMapSchema);
  const orgId = await getOrgId();
  const audit = await actor(req);
  return { AccountMap: await mapServiceErrors(() => accountMapService.updateAccountMap(orgId, id, data, audit)) };
};

export const deleteAccountMap: DonationRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  const audit = await actor(req);
  await mapServiceErrors(() => accountMapService.deleteAccountMap(orgId, id, audit));
  return {};
};
