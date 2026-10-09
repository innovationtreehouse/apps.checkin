/**
 * The approver surface (list, queue, counts, detail, line approvals, sign-off) and FINANCE's
 * per-expense actions. Approver reads are filtered here to the caller's buckets (viewerScope);
 * an expense outside that scope answers 404.
 */
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import type { ExpensePrincipal, ExpenseRouteHandler } from "../contract";
import { getExpenseRuntime, getOrgId, getPrincipal } from "../runtime";
import { SEATS, type FilledSeat } from "../lib/signoff";
import {
  approveLine,
  assignOwner,
  financeAssign,
  raiseException,
  rejectException,
  resolveUnknown,
} from "../services/approvalService";
import { CapitalReviewSchema, SetDepreciationCycleSchema, setDepreciationCycle, submitCapitalReview } from "../services/capitalService";
import { setReimbursee, signLine, signoffStatus } from "../services/signoffService";
import {
  httpError,
  mapServiceErrors,
  pageArgs,
  parseBody,
  parseId,
  query,
  scopedApprovals,
  scopedExpenses,
  scopedLines,
  viewerScope,
  type ViewerScope,
} from "./_shared";

const SUMMARY = {
  id: true,
  orgId: true,
  submitterId: true,
  vendorName: true,
  currency: true,
  taxCents: true,
  shippingCents: true,
  discountCents: true,
  receiptTotalCents: true,
  receiptDate: true,
  state: true,
  submittedAt: true,
  needsReimbursement: true,
  backfill: true,
} as const;

export const QUEUE_VIEWS = [
  "all",
  "assign_ownership",
  "resolve_ownership",
  "owner_approval",
  "owner_exception",
  "capital_review",
  "set_depreciation_cycle",
  "qb_pending",
] as const;
type QueueView = (typeof QUEUE_VIEWS)[number];

function viewWhere(view: QueueView, scope: ViewerScope): Prisma.ExpenseWhereInput {
  switch (view) {
    case "all":
      return {};
    case "assign_ownership":
      return { state: "assign_ownership", approvals: { some: { ownerId: null } } };
    case "resolve_ownership":
      return { approvals: { some: { status: "unknown" } } };
    case "owner_approval":
      return scope.all
        ? { state: "owner_approval", approvals: { none: { status: "exception_raised" } } }
        : { state: "owner_approval", approvals: { some: { status: "pending", ...scopedApprovals(scope) } } };
    case "owner_exception":
      return { approvals: { some: { status: "exception_raised" } } };
    default:
      return { state: view };
  }
}

function parseView(raw: string | null, fallback?: QueueView): QueueView {
  const view = raw ?? fallback;
  if (!view || !(QUEUE_VIEWS as readonly string[]).includes(view)) {
    throw httpError(400, `view must be one of: ${QUEUE_VIEWS.join(", ")}`);
  }
  return view as QueueView;
}

async function listWhere(principal: ExpensePrincipal, view: QueueView): Promise<Prisma.ExpenseWhereInput> {
  const scope = await viewerScope(principal);
  return { AND: [scopedExpenses(await getOrgId(), scope), viewWhere(view, scope)] };
}

/** The expense, or 404 when it is not in this org or not in the caller's scope. */
async function visibleExpense(principal: ExpensePrincipal, id: string) {
  const scope = await viewerScope(principal);
  const expense = await db.expense.findFirst({ where: { id, ...scopedExpenses(await getOrgId(), scope) } });
  if (!expense) throw httpError(404, "Expense not found");
  return { expense, scope };
}

export const list: ExpenseRouteHandler = async ({ req }) => {
  const sp = query(req);
  const where = await listWhere(await getPrincipal(), parseView(sp.get("view"), "all"));
  return { Expense: await db.expense.findMany({ where, select: SUMMARY, orderBy: { submittedAt: "desc" }, ...pageArgs(sp) }) };
};

export const count: ExpenseRouteHandler = async ({ req }) => {
  const where = await listWhere(await getPrincipal(), parseView(query(req).get("view"), "all"));
  return { ExpenseListCount: { total: await db.expense.count({ where }) } };
};

export const queue: ExpenseRouteHandler = async ({ req }) => {
  const where = await listWhere(await getPrincipal(), parseView(query(req).get("view")));
  return { Expense: await db.expense.findMany({ where, select: SUMMARY, orderBy: { submittedAt: "asc" } }) };
};

export const counts: ExpenseRouteHandler = async () => {
  const principal = await getPrincipal();
  const scope = await viewerScope(principal);
  const base = scopedExpenses(await getOrgId(), scope);
  const n = (where: Prisma.ExpenseWhereInput) => db.expense.count({ where: { AND: [base, where] } });
  const views = QUEUE_VIEWS.filter((v) => v !== "all");
  const [values, holds] = await Promise.all([
    Promise.all(views.map((v) => n(viewWhere(v, scope)))),
    n({ holds: { some: { status: "PENDING" } } }),
  ]);
  return { ExpenseCounts: { ...Object.fromEntries(views.map((v, i) => [v, values[i]])), expense_holds: holds } };
};

export const detail: ExpenseRouteHandler = async ({ params }) => {
  const principal = await getPrincipal();
  const { scope } = await visibleExpense(principal, params.id);
  const lines = scopedLines(scope);
  const Expense = await db.expense.findFirst({
    where: { id: params.id },
    include: {
      lineItems: { where: lines, orderBy: { lineNumber: "asc" }, include: { signoffs: true } },
      approvals: { where: scopedApprovals(scope), orderBy: { id: "asc" } },
      // Holds, the audit trail and flags are FINANCE and Board's; an approver sees their lines only.
      ...(scope.all
        ? {
            holds: { orderBy: { id: "asc" } },
            auditLog: { orderBy: { changedAt: "asc" } },
            flags: { orderBy: { raisedAt: "asc" } },
          }
        : {}),
    },
  });
  return { Expense };
};

export const lineItemApprovals: ExpenseRouteHandler = async ({ params }) => {
  const principal = await getPrincipal();
  const { scope } = await visibleExpense(principal, params.id);
  const approvals = await db.lineItemOwnerApproval.findMany({
    where: { expenseId: params.id, ...scopedApprovals(scope) },
    orderBy: { id: "asc" },
  });
  const used = new Set(approvals.map((a) => a.ownerId));
  const owners = (await getExpenseRuntime().budgetOwners.list()).filter((o) => scope.all || used.has(o.id));
  return { LineItemOwnerApproval: approvals, ExpenseBucketView: owners };
};

/** Runs an approval action on an expense the caller can see, then returns the approval row. */
function approvalAction<T>(
  schema: z.ZodType<T>,
  act: (principal: ExpensePrincipal, expenseId: string, approvalId: number, body: T) => Promise<void>,
): ExpenseRouteHandler {
  return async ({ req, params }) => {
    const approvalId = parseId(params.approvalId, "approvalId");
    const body = await parseBody(req, schema);
    const principal = await getPrincipal();
    await visibleExpense(principal, params.id);
    await mapServiceErrors(() => act(principal, params.id, approvalId, body));
    return { LineItemOwnerApproval: await db.lineItemOwnerApproval.findFirst({ where: { id: approvalId, expenseId: params.id } }) };
  };
}

const notesSchema = z.object({ notes: z.string().trim().min(1, "notes are required") });
const ownerSchema = z.object({ ownerId: z.number().int().positive() });

export const approve = approvalAction(
  z.object({ overrideComment: z.string().nullish() }),
  (p, e, a, b) => approveLine(p, e, a, b.overrideComment),
);
export const raise = approvalAction(notesSchema, (p, e, a, b) => raiseException(p, e, a, b.notes));
export const reject = approvalAction(notesSchema, (p, e, a, b) => rejectException(p, e, a, b.notes));
export const financeAssignOwner = approvalAction(ownerSchema, (p, e, a, b) => financeAssign(p, e, a, b.ownerId));
export const assign = approvalAction(
  ownerSchema.extend({ permanent: z.boolean().optional() }),
  (p, e, a, b) => assignOwner(p, e, a, b.ownerId, b.permanent ?? false),
);
export const resolve = approvalAction(ownerSchema, (p, e, a, b) => resolveUnknown(p, e, a, b.ownerId));

/** Sign-off status as seat names only: who signed is pii and lives on ExpenseLineSignoff. */
function seatsOnly(status: Awaited<ReturnType<typeof signoffStatus>>) {
  return status.map((s) => ({ ...s, filled: s.filled.map((f: FilledSeat) => f.seat) }));
}

export const signoffs: ExpenseRouteHandler = async ({ params }) => {
  const principal = await getPrincipal();
  const { scope } = await visibleExpense(principal, params.id);
  const visible = new Set(
    (await db.expenseLineItem.findMany({ where: { expenseId: params.id, ...scopedLines(scope) }, select: { id: true } })).map((l) => l.id),
  );
  const status = await mapServiceErrors(() => signoffStatus(params.id));
  return { ExpenseLineSignoffStatus: seatsOnly(status.filter((s) => visible.has(s.lineItemId))) };
};

/** The library decides which seat the caller may fill; the response is that line's status. */
export const sign: ExpenseRouteHandler = async ({ req, params }) => {
  const lineItemId = parseId(params.lineItemId, "lineItemId");
  const { seat } = await parseBody(req, z.object({ seat: z.enum(SEATS) }));
  const principal = await getPrincipal();
  const line = await db.expenseLineItem.findFirst({
    where: { id: lineItemId, expenseId: params.id, expense: { orgId: await getOrgId() } },
    select: { id: true },
  });
  if (!line) throw httpError(404, "Line item not found");
  await mapServiceErrors(() => signLine(principal, lineItemId, seat));
  const status = await signoffStatus(params.id);
  return { ExpenseLineSignoffStatus: seatsOnly(status.filter((s) => s.lineItemId === lineItemId)) };
};

async function expenseWithLines(id: string) {
  return db.expense.findFirst({ where: { id }, include: { lineItems: { orderBy: { lineNumber: "asc" } } } });
}

export const capitalReview: ExpenseRouteHandler = async ({ req, params }) => {
  const body = await parseBody(req, CapitalReviewSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() => submitCapitalReview(principal, params.id, body));
  return { Expense: await expenseWithLines(params.id) };
};

export const depreciationCycle: ExpenseRouteHandler = async ({ req, params }) => {
  const body = await parseBody(req, SetDepreciationCycleSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() => setDepreciationCycle(principal, params.id, body));
  return { Expense: await expenseWithLines(params.id) };
};

export const reimbursee: ExpenseRouteHandler = async ({ req, params }) => {
  const { personId } = await parseBody(req, z.object({ personId: z.number().int().positive() }));
  const principal = await getPrincipal();
  const orgId = await getOrgId();
  await mapServiceErrors(() => setReimbursee(orgId, params.id, personId, principal));
  return { Expense: await db.expense.findFirst({ where: { id: params.id, orgId } }) };
};
