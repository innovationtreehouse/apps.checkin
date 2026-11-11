/**
 * Route factories for the 11 registered /api/workflow-mapping/* endpoints. The host mounts each
 * under its handler(), which admits the caller and strips the returned model bag; bag keys are
 * the registry's `returns` model names.
 */
import { httpError, parseBody, parseId } from "@checkin/component-kit";
import { requireActor } from "./runtime";
import { rerunMatching } from "./services/pendingMatching";
import { assertEditable, loadReceipt } from "./services/receiptLookup";
import { receiptService } from "./services/receiptService";
import { AssociateBodySchema, ProposeBodySchema, lineItemService } from "./services/lineItemService";

export interface WorkflowRouteCtx {
  req: Request;
  params: Record<string, string>;
}
export type WorkflowBag = Record<string, unknown>;
export type WorkflowRouteHandler = (ctx: WorkflowRouteCtx) => Promise<WorkflowBag>;

const receiptId = (params: Record<string, string>) => parseId(params.id, "receipt id");
const lineId = (params: Record<string, string>) => parseId(params.lineStatusId, "line id");

/**
 * `?state=a,b` (or repeated `state`) filters the queue by state, and repeated `receiptId`
 * narrows it to those receipts; an absent filter does not narrow.
 */
export function listFilter(sp: URLSearchParams): { states?: string[]; receiptIds?: string[] } {
  const states = sp.getAll("state").flatMap((s) => s.split(",")).filter(Boolean);
  const receiptIds = sp.getAll("receiptId").filter(Boolean);
  return { ...(states.length ? { states } : {}), ...(receiptIds.length ? { receiptIds } : {}) };
}

export const listReceipts: WorkflowRouteHandler = async ({ req }) => {
  const { states, receiptIds } = listFilter(new URL(req.url).searchParams);
  return { WorkflowReceiptSummary: await receiptService.list(states, receiptIds) };
};

export const receiptCounts: WorkflowRouteHandler = async () => ({
  WorkflowReceiptCount: await receiptService.counts(),
});

export const receiptDetail: WorkflowRouteHandler = async ({ params }) => {
  const { receipt, parsedReceipt, lineStatuses } = await receiptService.detail(receiptId(params));
  return { ReceivedReceipt: receipt, WorkflowReceiptView: parsedReceipt, ReceivedReceiptLineStatus: lineStatuses };
};

export const auditLog: WorkflowRouteHandler = async ({ req }) => {
  const sp = new URL(req.url).searchParams;
  const before = sp.get("before");
  return {
    WorkflowAuditLog: await receiptService.auditLog({
      receiptId: sp.has("receiptId") ? parseId(sp.get("receiptId"), "receiptId") : null,
      limit: Number(sp.get("limit")) || null,
      before: before ? new Date(before) : null,
    }),
  };
};

export const proceed: WorkflowRouteHandler = async ({ params }) => {
  const id = receiptId(params);
  const { state } = await receiptService.proceed(id);
  return { ReceivedReceipt: { id, state } };
};

/** A failed push answers 200 with its state (`apply_failed`, or `applying` when only the inventory stamp failed) and the reason in `validationNotes`. */
export const apply: WorkflowRouteHandler = async ({ params }) => {
  const id = receiptId(params);
  const result = await receiptService.apply(id);
  return {
    ReceivedReceipt: result.state === "resolved"
      ? { id, state: result.state }
      : { id, state: result.state, validationNotes: result.error },
  };
};

export const retryApply: WorkflowRouteHandler = async ({ params }) => {
  const id = receiptId(params);
  const { state } = await receiptService.retryApply(id);
  return { ReceivedReceipt: { id, state } };
};

/** Runs matching now for one receipt in "Matching pending"; one the catalog still can't answer stays pending. */
export const runMatching: WorkflowRouteHandler = async ({ params }) => {
  const actor = await requireActor();
  const id = receiptId(params);
  const received = await loadReceipt(id);
  assertEditable(received);
  if (!received.matchingPendingSince) throw httpError(409, "Matching already ran for this receipt");
  await rerunMatching(received, actor);
  const { state } = await loadReceipt(id);
  return { ReceivedReceipt: { id, state } };
};

export const associate: WorkflowRouteHandler = async ({ req, params }) => {
  const body = await parseBody(req, AssociateBodySchema);
  await lineItemService.associateGtin(receiptId(params), lineId(params), body);
  return {};
};

/** The service's `provisionalGtin13` is the line's `provisionalItemGtin13` field; the stripper knows only the latter. */
export const propose: WorkflowRouteHandler = async ({ req, params }) => {
  const body = await parseBody(req, ProposeBodySchema);
  const id = lineId(params);
  const { provisionalGtin13 } = await lineItemService.proposeProvisionalItem(receiptId(params), id, body);
  return { ReceivedReceiptLineStatus: { id, provisionalItemGtin13: provisionalGtin13 } };
};

export const nonInventory: WorkflowRouteHandler = async ({ params }) => {
  await lineItemService.markNonInventory(receiptId(params), lineId(params));
  return {};
};
