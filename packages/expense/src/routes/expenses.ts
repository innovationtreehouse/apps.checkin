/**
 * The approver surface (list, queue, counts, detail, line approvals, sign-off) and FINANCE's
 * per-expense actions. Approver reads are filtered here to the caller's buckets (viewerScope);
 * an expense outside that scope answers 404.
 */
import { httpError, mapServiceErrors, parseBody, parseId, query } from "@checkin/component-kit";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import type { ExpensePrincipal, ExpenseRouteHandler } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import { CLOSED_STATES, SEATS, type FilledSeat } from "../lib/signoff";
import {
  APPROVABLE_STATUSES,
  approveLine,
  approveLines,
  assignOwner,
  financeAssign,
  raiseException,
  rejectException,
  resolveUnknown,
} from "../services/approvalService";
import { CapitalReviewSchema, SetDepreciationCycleSchema, setDepreciationCycle, submitCapitalReview } from "../services/capitalService";
import { linkReimburseeVendor, reimburseeVendorFor, vendorOptions } from "../services/reimburseeVendorService";
import { recordBoardAuthorization, reimburseeOptions, setReimbursee, signLine, signLines, signoffStatusFor } from "../services/signoffService";
import { setTestData } from "../services/testDataService";
import { allExpensesAwaitingMyApproval } from "../services/badgeCounts";
import { EXPENSE_LIST_VIEWS, expenseViewsFor, type ExpenseListView, type ExpenseViewer } from "../nav";
import { OPEN_REVIEWS_WHERE, expenseReasons } from "../services/reasonService";
import { approveTax } from "../services/taxApprovalService";
import { pageArgs, scopedApprovals, scopedExpenses, scopedLines, viewerScope, type ViewerScope } from "./_shared";

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

export const QUEUE_VIEWS = EXPENSE_LIST_VIEWS;
type QueueView = ExpenseListView;

/** The views whose rows are a fixed set of expenses, counted in the database. */
type StateView = Exclude<QueueView, "awaiting_me">;

function viewWhere(view: StateView, scope: ViewerScope): Prisma.ExpenseWhereInput {
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
        : { state: "owner_approval", approvals: { some: { status: { in: [...APPROVABLE_STATUSES] }, ...scopedApprovals(scope) } } };
    case "owner_exception":
      return { approvals: { some: { status: "exception_raised" } } };
    default:
      return { state: view };
  }
}

/** The roles the services check, for the views the caller can act in. */
async function viewerOf(principal: ExpensePrincipal): Promise<ExpenseViewer> {
  const approver = (await getExpenseRuntime().signoff.bucketsApprovedBy(callerId(principal))).length > 0;
  return { approver, isFinance: principal.isFinance, isBoard: principal.isBoard };
}

/** The view, refused when it is unknown or one the caller cannot act in. */
async function parseView(principal: ExpensePrincipal, raw: string | null, fallback?: QueueView): Promise<QueueView> {
  const view = raw ?? fallback;
  if (!view || !(QUEUE_VIEWS as readonly string[]).includes(view)) {
    throw httpError(400, `view must be one of: ${QUEUE_VIEWS.join(", ")}`);
  }
  if (!expenseViewsFor(await viewerOf(principal)).includes(view as QueueView)) throw httpError(403, "You cannot act in this view");
  return view as QueueView;
}

/** "Waiting on you" lists every expense with a line waiting on the caller's approval. */
async function listWhere(principal: ExpensePrincipal, view: QueueView, activeOnly = false): Promise<Prisma.ExpenseWhereInput> {
  const scope = await viewerScope(principal);
  const viewFilter =
    view === "awaiting_me"
      ? { id: { in: (await allExpensesAwaitingMyApproval(principal)).map((e) => e.expenseId) } }
      : viewWhere(view, scope);
  const where = [scopedExpenses(await getOrgId(), scope), viewFilter];
  if (activeOnly) where.push({ state: { notIn: [...CLOSED_STATES] } });
  return { AND: where };
}

/** `active=1` drops closed expenses from the list and its count. */
const activeOnly = (sp: URLSearchParams) => sp.get("active") === "1";

/** The expense, or 404 when it is not in this org or not in the caller's scope. */
async function visibleExpense(principal: ExpensePrincipal, id: string) {
  const scope = await viewerScope(principal);
  const expense = await db.expense.findFirst({ where: { id, ...scopedExpenses(await getOrgId(), scope) } });
  if (!expense) throw httpError(404, "Expense not found");
  return { expense, scope };
}

export const list: ExpenseRouteHandler = async ({ req, principal }) => {
  const sp = query(req);
  const where = await listWhere(principal, await parseView(principal, sp.get("view"), "all"), activeOnly(sp));
  return { Expense: await db.expense.findMany({ where, select: SUMMARY, orderBy: { submittedAt: "desc" }, ...pageArgs(sp) }) };
};

export const count: ExpenseRouteHandler = async ({ req, principal }) => {
  const sp = query(req);
  const where = await listWhere(principal, await parseView(principal, sp.get("view"), "all"), activeOnly(sp));
  return { ExpenseListCount: { total: await db.expense.count({ where }) } };
};

export const queue: ExpenseRouteHandler = async ({ req, principal }) => {
  const sp = query(req);
  const where = await listWhere(principal, await parseView(principal, sp.get("view")));
  return { Expense: await db.expense.findMany({ where, select: SUMMARY, orderBy: [{ submittedAt: "asc" }, { id: "asc" }], ...pageArgs(sp) }) };
};

export const counts: ExpenseRouteHandler = async ({ principal }) => {
  const scope = await viewerScope(principal);
  const base = scopedExpenses(await getOrgId(), scope);
  const n = (where: Prisma.ExpenseWhereInput) => db.expense.count({ where: { AND: [base, where] } });
  const visible = expenseViewsFor(await viewerOf(principal));
  const views = visible.filter((v): v is Exclude<StateView, "all"> => v !== "all" && v !== "awaiting_me");
  const [values, holds] = await Promise.all([
    Promise.all(views.map((v) => n(viewWhere(v, scope)))),
    n({ holds: { some: { status: "PENDING" } } }),
  ]);
  return { ExpenseCounts: { ...Object.fromEntries(views.map((v, i) => [v, values[i]])), expense_holds: holds } };
};

export const detail: ExpenseRouteHandler = async ({ params, principal }) => {
  const { scope } = await visibleExpense(principal, params.id);
  const lines = scopedLines(scope);
  const Expense = await db.expense.findFirst({
    where: { id: params.id },
    include: {
      lineItems: { where: lines, orderBy: { lineNumber: "asc" }, include: { signoffs: true } },
      approvals: { where: scopedApprovals(scope), orderBy: { id: "asc" } },
      // Holds, the audit trail, reviews and reasons are FINANCE and Board's; an approver sees their lines only.
      ...(scope.all
        ? {
            holds: { orderBy: { id: "asc" } },
            auditLog: { orderBy: { changedAt: "asc" } },
            flags: { where: OPEN_REVIEWS_WHERE, orderBy: { raisedAt: "asc" } },
          }
        : {}),
    },
  });
  return { Expense, ExpenseQueueReason: scope.all ? await expenseReasons(principal, params.id) : [] };
};

export const lineItemApprovals: ExpenseRouteHandler = async ({ params, principal }) => {
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
  return async ({ req, params, principal }) => {
    const approvalId = parseId(params.approvalId, "approvalId");
    const body = await parseBody(req, schema);
    await visibleExpense(principal, params.id);
    await mapServiceErrors(() => act(principal, params.id, approvalId, body));
    return { LineItemOwnerApproval: await db.lineItemOwnerApproval.findFirst({ where: { id: approvalId, expenseId: params.id } }) };
  };
}

const notesSchema = z.object({ notes: z.string().trim().min(1, "notes are required") });
const ownerSchema = z.object({ ownerId: z.number().int().positive() });

export const approve = approvalAction(
  z.object({ reason: z.string().nullish() }),
  (p, e, a, b) => approveLine(p, e, a, b.reason),
);
/** Approve All: every listed line the caller approves, or none; the response is those approval rows. */
export const approveAll: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const { approvalIds } = await parseBody(req, z.object({ approvalIds: z.array(z.number().int().positive()).min(1, "Name at least one line to approve") }));
  await visibleExpense(principal, params.id);
  await mapServiceErrors(() => approveLines(principal, params.id, approvalIds));
  return {
    LineItemOwnerApproval: await db.lineItemOwnerApproval.findMany({ where: { id: { in: approvalIds }, expenseId: params.id }, orderBy: { id: "asc" } }),
  };
};
export const raise = approvalAction(notesSchema,(p, e, a, b) => raiseException(p, e, a, b.notes));
export const reject = approvalAction(notesSchema, (p, e, a, b) => rejectException(p, e, a, b.notes));
export const financeAssignOwner = approvalAction(
  ownerSchema.extend({ final: z.boolean().optional(), note: z.string().nullish() }),
  (p, e, a, b) => financeAssign(p, e, a, b.ownerId, b.final ?? false, b.note),
);
export const assign = approvalAction(
  ownerSchema.extend({ permanent: z.boolean().optional() }),
  (p, e, a, b) => assignOwner(p, e, a, b.ownerId, b.permanent ?? false),
);
export const resolve = approvalAction(ownerSchema, (p, e, a, b) => resolveUnknown(p, e, a, b.ownerId));

/** Sign-off status as seat names only: who signed is pii and lives on ExpenseLineSignoff. */
function seatsOnly<T extends { filled: FilledSeat[] }>(status: T[]) {
  return status.map((s) => ({ ...s, filled: s.filled.map((f) => f.seat) }));
}

export const signoffs: ExpenseRouteHandler = async ({ params, principal }) => {
  const { scope } = await visibleExpense(principal, params.id);
  const visible = new Set(
    (await db.expenseLineItem.findMany({ where: { expenseId: params.id, ...scopedLines(scope) }, select: { id: true } })).map((l) => l.id),
  );
  const status = await mapServiceErrors(() => signoffStatusFor(principal, params.id));
  return { ExpenseLineSignoffStatus: seatsOnly(status.filter((s) => visible.has(s.lineItemId))) };
};

/**
 * Whether the caller has any part in signing this line: its submitter, an approver of its
 * bucket, FINANCE or Board. Anyone else gets the same 404 as for a line that does not exist,
 * so the route reveals nothing about an expense to a caller with no part in it.
 */
async function maySign(principal: ExpensePrincipal, line: { expense: { submitterId: number }; approvals: { ownerId: number | null }[] }) {
  if (principal.isFinance || principal.isBoard) return true;
  const me = callerId(principal);
  if (line.expense.submitterId === me) return true;
  const buckets = new Set(await getExpenseRuntime().signoff.bucketsApprovedBy(me));
  return line.approvals.some((a) => a.ownerId !== null && buckets.has(a.ownerId));
}

/** The library decides which seat the caller may fill; the response is that line's status. */
export const sign: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const lineItemId = parseId(params.lineItemId, "lineItemId");
  const { seat } = await parseBody(req, z.object({ seat: z.enum(SEATS) }));
  const line = await db.expenseLineItem.findFirst({
    where: { id: lineItemId, expenseId: params.id, expense: { orgId: await getOrgId() } },
    select: { expense: { select: { submitterId: true } }, approvals: { select: { ownerId: true } } },
  });
  if (!line || !(await maySign(principal, line))) throw httpError(404, "Line item not found");
  await mapServiceErrors(() => signLine(principal, lineItemId, seat));
  const status = await signoffStatusFor(principal, params.id);
  return { ExpenseLineSignoffStatus: seatsOnly(status.filter((s) => s.lineItemId === lineItemId)) };
};

/** Sign all as Treasurer: every listed line the caller may sign, or none; the response is those lines' status. */
export const signAll: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const { lineItemIds } = await parseBody(req, z.object({ lineItemIds: z.array(z.number().int().positive()).min(1, "Name at least one line to sign") }));
  await mapServiceErrors(() => signLines(principal, params.id, lineItemIds));
  const listed = new Set(lineItemIds);
  return { ExpenseLineSignoffStatus: seatsOnly((await signoffStatusFor(principal, params.id)).filter((s) => listed.has(s.lineItemId))) };
};

/** The library decides who may record the Board authorization; the response is every line's status. */
export const boardAuthorization: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const { authorization } = await parseBody(req, z.object({ authorization: z.string().trim().min(1, "Say what the Board authorized") }));
  await mapServiceErrors(() => recordBoardAuthorization(principal, params.id, authorization));
  return { ExpenseLineSignoffStatus: seatsOnly(await signoffStatusFor(principal, params.id)) };
};

async function expenseWithLines(id: string) {
  return db.expense.findFirst({ where: { id }, include: { lineItems: { orderBy: { lineNumber: "asc" } } } });
}

export const capitalReview: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const body = await parseBody(req, CapitalReviewSchema);
  await mapServiceErrors(() => submitCapitalReview(principal, params.id, body));
  return { Expense: await expenseWithLines(params.id) };
};

export const depreciationCycle: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const body = await parseBody(req, SetDepreciationCycleSchema);
  await mapServiceErrors(() => setDepreciationCycle(principal, params.id, body));
  return { Expense: await expenseWithLines(params.id) };
};

// A new person is added only with the adder's word that they are an adult.
const reimburseeChoiceSchema = z.union([
  z.object({ personId: z.number().int().positive() }).strict(),
  z.object({ newPerson: z.object({ name: z.string().trim().min(1).max(200), isAdult: z.literal(true) }).strict() }).strict(),
]);

export const reimbursee: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const choice = await parseBody(req, reimburseeChoiceSchema);
  const orgId = await getOrgId();
  await mapServiceErrors(() => setReimbursee(orgId, params.id, choice, principal));
  return { Expense: await db.expense.findFirst({ where: { id: params.id, orgId } }) };
};

export const reimburseePeople: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const orgId = await getOrgId();
  const people = await mapServiceErrors(async () => {
    const text = z.string().max(100).parse(query(req).get("q") ?? "");
    return reimburseeOptions(orgId, params.id, text, principal);
  });
  return { ExpenseReimburseeView: people };
};

const vendorChoiceSchema = z.union([
  z.object({ qbVendorId: z.string().trim().regex(/^\d+$/, "qbVendorId is a QuickBooks id") }).strict(),
  z.object({ createForReimbursee: z.literal(true) }).strict(),
]);

export const reimburseeVendor: ExpenseRouteHandler = async ({ params }) => {
  const orgId = await getOrgId();
  const { link, reimbursee } = await mapServiceErrors(() => reimburseeVendorFor(orgId, params.id));
  return { ExpenseReimburseeVendor: link, ExpenseReimburseeView: reimbursee };
};

export const reimburseeVendorOptions: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const orgId = await getOrgId();
  const options = await mapServiceErrors(async () => {
    const text = z.string().trim().min(2, "Type at least two letters").max(100).parse(query(req).get("q") ?? "");
    return vendorOptions(orgId, params.id, text, principal);
  });
  return { ExpenseQbVendorOption: options };
};

export const linkVendor: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const choice = await parseBody(req, vendorChoiceSchema);
  const orgId = await getOrgId();
  return { ExpenseReimburseeVendor: await mapServiceErrors(() => linkReimburseeVendor(orgId, params.id, choice, principal)) };
};

export const testData: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const { isTestData } = await parseBody(req, z.object({ isTestData: z.boolean() }));
  await mapServiceErrors(() => setTestData(principal, params.id, isTestData));
  return { Expense: await db.expense.findFirst({ where: { id: params.id, orgId: await getOrgId() } }) };
};

export const taxApproval: ExpenseRouteHandler = async ({ req, params, principal }) => {
  const { note } = await parseBody(req, z.object({ note: z.string().nullish() }));
  await mapServiceErrors(() => approveTax(principal, params.id, note?.trim() || null));
  return { Expense: await db.expense.findFirst({ where: { id: params.id, orgId: await getOrgId() } }) };
};
