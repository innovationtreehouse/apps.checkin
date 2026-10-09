/**
 * Route factories for the 10 registered /api/workflow-mapping/* endpoints. The host mounts each
 * under its handler(), which admits the caller and strips the returned model bag; bag keys are
 * the registry's `returns` model names.
 */
import type { ZodType } from "zod";
import { httpError } from "./runtime";
import { receiptService } from "./services/receiptService";
import { AssociateBodySchema, ProposeBodySchema, lineItemService } from "./services/lineItemService";

export interface WorkflowRouteCtx {
  req: Request;
  params: Record<string, string>;
}
export type WorkflowBag = Record<string, unknown>;
export type WorkflowRouteHandler = (ctx: WorkflowRouteCtx) => Promise<WorkflowBag>;

function parseId(raw: string | null | undefined, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${label}`);
  return n;
}

async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
  const result = schema.safeParse(json);
  if (!result.success) throw httpError(400, result.error.issues[0]?.message ?? "Invalid request body");
  return result.data;
}

const receiptId = (params: Record<string, string>) => parseId(params.id, "receipt id");
const lineId = (params: Record<string, string>) => parseId(params.lineStatusId, "line id");

/** `?state=a,b` (or repeated `state`) filters the queue; absent lists every state. */
export const listReceipts: WorkflowRouteHandler = async ({ req }) => {
  const states = new URL(req.url).searchParams.getAll("state").flatMap((s) => s.split(",")).filter(Boolean);
  return { WorkflowReceiptSummary: await receiptService.list(states.length ? states : undefined) };
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

/** A failed push answers 200 with `state: "apply_failed"` and the reason in `validationNotes`. */
export const apply: WorkflowRouteHandler = async ({ params }) => {
  const id = receiptId(params);
  const result = await receiptService.apply(id);
  return {
    ReceivedReceipt: result.state === "apply_failed"
      ? { id, state: result.state, validationNotes: result.error }
      : { id, state: result.state },
  };
};

export const retryApply: WorkflowRouteHandler = async ({ params }) => {
  const id = receiptId(params);
  const { state } = await receiptService.retryApply(id);
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
