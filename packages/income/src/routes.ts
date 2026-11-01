/**
 * Route factories for /api/income/*. The host mounts each under its handler(), which
 * authorizes and strips the returned bag; a factory parses, calls a service, and names
 * each value by the model the host classifies it as.
 */
import { httpError, mapServiceErrors, parseBody, parseId } from "@checkin/component-kit";
import { z } from "zod";
import { db } from "./db";
import type { IncomeRouteHandler } from "./contract";
import { getIncomeConfig, getOrgId, getPrincipal } from "./runtime";
import { runReconcile } from "./lib/reconcile";
import { DEPOSIT_SOURCE } from "./lib/sources";
import { reconciliationService, type Actor, type ResolveAction } from "./services/reconciliationService";
import { itemCategoryService } from "./services/itemCategoryService";

const NOT_AN_OBJECT = "Expected a JSON object";

const isJsonObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

const requiredString = (key: string) =>
  z.string({ error: `${key} is required` }).trim().min(1, { error: `${key} is required` });

const resolveBody = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("match"), reason: z.string({ error: "reason must be a string" }).optional(), depositId: requiredString("depositId") }),
    z.object({ action: z.literal("dismiss"), reason: requiredString("reason") }),
    z.object({ action: z.literal("retry") }),
    z.object({ action: z.literal("book") }),
    z.object({ action: z.literal("clear_note"), reason: requiredString("reason") }),
  ],
  { error: (issue) => (isJsonObject(issue.input) ? "action must be match, dismiss, retry, book or clear_note" : NOT_AN_OBJECT) },
);

const positiveIntOrNull = { error: "budgetOwnerId must be a positive integer or null" };
// null is finance's choice of general income.
const setCategoryBody = z.object(
  { budgetOwnerId: z.number(positiveIntOrNull).int(positiveIntOrNull).positive(positiveIntOrNull).nullable() },
  { error: NOT_AN_OBJECT },
);

const excludeBody = z.object({ qbTxnId: requiredString("qbTxnId"), reason: requiredString("reason") }, { error: NOT_AN_OBJECT });

async function actor(): Promise<Actor> {
  const p = await getPrincipal();
  return { userId: p.id, username: p.name ?? undefined };
}

/** Next may hand a URL-encoded payout GID through unchanged. */
function payoutGid(raw: string | undefined): string {
  const gid = decodeURIComponent(raw ?? "");
  if (!gid) throw httpError(400, "Invalid payout id");
  return gid;
}

export const listPayouts: IncomeRouteHandler = async () => {
  const { mirror, reconcileFrom } = getIncomeConfig();
  return { IncomePayoutView: mirror ? await mirror.paidPayoutsSince(reconcileFrom ?? new Date(0)) : [] };
};

export const getPayout: IncomeRouteHandler = async ({ params }) => {
  const gid = payoutGid(params.gid);
  const mirror = getIncomeConfig().mirror;
  const payout = mirror ? await mirror.payout(gid) : null;
  if (!mirror || !payout) throw httpError(404, "Payout not found");
  const orgId = await getOrgId();
  const [transactions, reconciliation] = await Promise.all([
    mirror.transactions(gid),
    db.payoutReconciliation.findUnique({ where: { orgId_source_payoutGid: { orgId, source: DEPOSIT_SOURCE.SHOPIFY, payoutGid: gid } } }),
  ]);
  return { IncomePayoutView: payout, IncomeBalanceTxnView: transactions, PayoutReconciliation: reconciliation };
};

export const listReconciliation: IncomeRouteHandler = async () => ({
  PayoutReconciliation: await reconciliationService.listQueue(await getOrgId()),
});

export const countReconciliation: IncomeRouteHandler = async () => ({
  IncomeReconciliationCount: { total: await reconciliationService.countQueue(await getOrgId()) },
});

export const candidates: IncomeRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  return { IncomeQbDepositView: await mapServiceErrors(() => reconciliationService.candidates(orgId, id)) };
};

export const resolve: IncomeRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const action: ResolveAction = await parseBody(req, resolveBody);
  const [orgId, who] = await Promise.all([getOrgId(), actor()]);
  return { PayoutReconciliation: await mapServiceErrors(() => reconciliationService.resolve(orgId, id, action, who)) };
};

/** Run reconciliation now. An unbound mirror or deposit source answers zero counts. */
export const run: IncomeRouteHandler = async () => {
  const result = await runReconcile(await getOrgId());
  if (result.status === "busy") throw httpError(409, "A reconciliation run is already in progress");
  const counts = result.status === "ran" ? result : { matched: 0, opened: 0, drifted: 0 };
  return {
    IncomeReconciliationCount: { status: result.status, matched: counts.matched, opened: counts.opened, drifted: counts.drifted },
  };
};

export const listItems: IncomeRouteHandler = async () => ({
  IncomeItemView: await itemCategoryService.listItems(await getOrgId()),
});

function variantId(raw: string | undefined): string {
  if (!raw || !/^\d+$/.test(raw)) throw httpError(400, "Invalid variant id");
  return raw;
}

export const setItemCategory: IncomeRouteHandler = async ({ req, params }) => {
  const variant = variantId(params.variantId);
  const { budgetOwnerId } = await parseBody(req, setCategoryBody);
  const [orgId, who] = await Promise.all([getOrgId(), actor()]);
  return {
    IncomeItemCategory: await mapServiceErrors(() => itemCategoryService.setCategory(orgId, variant, budgetOwnerId, who)),
  };
};

export const clearItemCategory: IncomeRouteHandler = async ({ params }) => {
  const variant = variantId(params.variantId);
  const [orgId, who] = await Promise.all([getOrgId(), actor()]);
  return { IncomeItemCategory: await mapServiceErrors(() => itemCategoryService.clearCategory(orgId, variant, who)) };
};

export const listExclusions: IncomeRouteHandler = async () => ({
  IncomeQbMatchExclusion: await reconciliationService.listExclusions(await getOrgId()),
});

export const excludeDeposit: IncomeRouteHandler = async ({ req }) => {
  const { qbTxnId, reason } = await parseBody(req, excludeBody);
  const [orgId, who] = await Promise.all([getOrgId(), actor()]);
  return {
    IncomeQbMatchExclusion: await mapServiceErrors(() => reconciliationService.excludeDeposit(orgId, qbTxnId, reason, who)),
  };
};
