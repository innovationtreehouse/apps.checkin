/** Finance curation: comment rules (read + delete) and the GL account map. */
import { httpError, mapServiceErrors, parseBody, parseId } from "@checkin/component-kit";
import { LINE_ACCOUNT_TYPES, accountTypeRefusal } from "@checkin/quickbooks";
import { z } from "zod";
import { accountMapService } from "../services/accountMapService";
import { commentRuleService } from "../services/commentRuleService";
import { getOrgId, getQuickBooksAccounts } from "../runtime";
import type { DonationRouteHandler } from "../contract";
import { auditContext, pageArgs } from "./_shared";

async function actor(req: Request): Promise<{ userId: number; username: string; correlationId: string | null }> {
  const audit = await auditContext(req);
  return { userId: audit.actorUserId, username: audit.actorUsername, correlationId: audit.correlationId ?? null };
}

const required = (label: string) => z.string().trim().min(1, `${label} is required`);
const optional = z.string().trim().nullish().transform((s) => (s ? s : null));
const qbAccountId = optional.refine((s) => s === null || /^\d+$/.test(s), "must be a QuickBooks account id (digits only)");

const accountMapSchema = z.object({
  companyName: required("companyName"),
  corporatePeerCampaign: required("corporatePeerCampaign"),
  donationMethod: optional,
  donationType: optional,
  donationAccountId: qbAccountId,
  matchAccountId: qbAccountId,
});

type AccountMapBody = z.infer<typeof accountMapSchema>;

type StoredAccounts = { donationAccountId: string | null; matchAccountId: string | null };

/** Refuses a rule account QuickBooks doesn't list, or lists under a type a gift can't book to; an account the stored rule already has isn't re-read. */
async function refuseWrongTypes(data: AccountMapBody, stored?: StoredAccounts | null): Promise<void> {
  const picked = ([
    ["donation", data.donationAccountId, stored?.donationAccountId],
    ["match", data.matchAccountId, stored?.matchAccountId],
  ] as const).flatMap(([kind, id, storedId]) => (id === null || id === storedId ? [] : [{ kind, id }]));
  if (picked.length === 0) return;
  const accounts = await mapServiceErrors(getQuickBooksAccounts());
  for (const { kind, id } of picked) {
    const refusal = accountTypeRefusal(accounts, id, LINE_ACCOUNT_TYPES.givingGift, `A rule's ${kind} account`);
    if (refusal) throw httpError(400, refusal);
  }
}

export const listCommentRules: DonationRouteHandler = async ({ req }) => {
  return { TransactionCommentRule: await commentRuleService.listCommentRules(await getOrgId(), pageArgs(req)) };
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
  await refuseWrongTypes(data);
  const audit = await actor(req);
  return { AccountMap: await accountMapService.createAccountMap(await getOrgId(), data, audit) };
};

export const updateAccountMap: DonationRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const data = await parseBody(req, accountMapSchema);
  const orgId = await getOrgId();
  await refuseWrongTypes(data, await accountMapService.findAccountMap(orgId, id));
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
