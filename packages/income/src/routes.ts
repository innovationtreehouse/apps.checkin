/**
 * Route factories for /api/income/*. The host mounts each under its handler(), which
 * authorizes and strips the returned bag; a factory parses, calls a service, and names
 * each value by the model the host classifies it as.
 */
import { db } from "./db";
import type { IncomeRouteHandler } from "./contract";
import { getIncomeConfig, getOrgId, getPrincipal, IncomeHttpError, mapServiceErrors } from "./runtime";
import { RECON_STATUS, runReconcile } from "./lib/reconcile";
import { reconciliationService, type Actor, type ResolveAction } from "./services/reconciliationService";
import { itemCategoryService } from "./services/itemCategoryService";

function parseId(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new IncomeHttpError(400, "Invalid id");
  return n;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new IncomeHttpError(400, "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new IncomeHttpError(400, "Expected a JSON object");
  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw new IncomeHttpError(400, `${key} is required`);
  return v.trim();
}

async function actor(): Promise<Actor> {
  const p = await getPrincipal();
  return { userId: p.id, username: p.name ?? undefined };
}

/** Next may hand a URL-encoded payout GID through unchanged. */
function payoutGid(raw: string | undefined): string {
  const gid = decodeURIComponent(raw ?? "");
  if (!gid) throw new IncomeHttpError(400, "Invalid payout id");
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
  if (!mirror || !payout) throw new IncomeHttpError(404, "Payout not found");
  const orgId = await getOrgId();
  const [transactions, reconciliation] = await Promise.all([
    mirror.transactions(gid),
    db.payoutReconciliation.findUnique({ where: { orgId_payoutGid: { orgId, payoutGid: gid } } }),
  ]);
  return { IncomePayoutView: payout, IncomeBalanceTxnView: transactions, PayoutReconciliation: reconciliation };
};

export const listReconciliation: IncomeRouteHandler = async () => ({
  PayoutReconciliation: await reconciliationService.list(await getOrgId(), RECON_STATUS.OPEN),
});

export const countReconciliation: IncomeRouteHandler = async () => ({
  IncomeReconciliationCount: { total: await reconciliationService.count(await getOrgId(), RECON_STATUS.OPEN) },
});

export const candidates: IncomeRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  return { IncomeQbDepositView: await mapServiceErrors(() => reconciliationService.candidates(orgId, id)) };
};

function resolveAction(body: Record<string, unknown>): ResolveAction {
  switch (body.action) {
    case "match":
      return { action: "match", depositId: requiredString(body, "depositId") };
    case "dismiss":
      return { action: "dismiss", reason: requiredString(body, "reason") };
    case "retry":
      return { action: "retry" };
    default:
      throw new IncomeHttpError(400, "action must be match, dismiss or retry");
  }
}

export const resolve: IncomeRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const action = resolveAction(await readBody(req));
  const [orgId, who] = await Promise.all([getOrgId(), actor()]);
  return { PayoutReconciliation: await mapServiceErrors(() => reconciliationService.resolve(orgId, id, action, who)) };
};

/** Run reconciliation now. An unbound mirror or deposit source answers zero counts. */
export const run: IncomeRouteHandler = async () => {
  const result = await runReconcile(await getOrgId());
  if (result.status === "busy") throw new IncomeHttpError(409, "A reconciliation run is already in progress");
  const counts = result.status === "ran" ? result : { matched: 0, opened: 0, drifted: 0 };
  return {
    IncomeReconciliationCount: { status: result.status, matched: counts.matched, opened: counts.opened, drifted: counts.drifted },
  };
};

export const listItems: IncomeRouteHandler = async () => ({
  IncomeItemView: await itemCategoryService.listItems(await getOrgId()),
});

function variantId(raw: string | undefined): string {
  if (!raw || !/^\d+$/.test(raw)) throw new IncomeHttpError(400, "Invalid variant id");
  return raw;
}

export const setItemCategory: IncomeRouteHandler = async ({ req, params }) => {
  const variant = variantId(params.variantId);
  const budgetOwnerId = (await readBody(req)).budgetOwnerId;
  if (typeof budgetOwnerId !== "number" || !Number.isInteger(budgetOwnerId) || budgetOwnerId <= 0) {
    throw new IncomeHttpError(400, "budgetOwnerId must be a positive integer");
  }
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
  const body = await readBody(req);
  const qbTxnId = requiredString(body, "qbTxnId");
  const reason = requiredString(body, "reason");
  const [orgId, who] = await Promise.all([getOrgId(), actor()]);
  return {
    IncomeQbMatchExclusion: await mapServiceErrors(() => reconciliationService.excludeDeposit(orgId, qbTxnId, reason, who)),
  };
};
