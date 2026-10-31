// The open queue reasons on one expense, with whether the viewer can act on each.
import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import { REVIEW_KINDS, reviewKindOf } from "../lib/flags";
import { deriveReasons, type DerivedReason, type QueueReason, type ReasonCode } from "../lib/reasons";
import { CLOSED_STATES, blockedSeats, boardAuthorizationRefusal, reimburseeUnknown } from "../lib/signoff";
import { boardApprovalNeeded, conflictedParties, filledSeatsByLine, signoffFactsByLine } from "../lib/signoff-facts";
import { POSTABLE_QB_STATES } from "../lib/expense-qb-poster";
import { reimburseeVendorId } from "./reimburseeVendorService";

/** Open flag rows that are reviews: the kept kinds. */
export const OPEN_REVIEWS_WHERE: Prisma.ExpenseFlagWhereInput = { checkedOffAt: null, kind: { in: [...REVIEW_KINDS] } };

/**
 * Bookkeeping on a purchase already signed off, which any finance holder does, conflicted or not
 * (docs/rules/expenses.md, Receipts): capital designation, depreciation, a hold's account, and
 * resubmitting a held or failed post.
 */
const BOOKKEEPING = new Set<ReasonCode>(["CAPITAL_REVIEW", "DEPRECIATION_CYCLE", "ACCOUNT_HOLD", "QB_POST_FAILED"]);

/** Reasons a conflicted FINANCE holder answers by choosing the line's bucket. */
const BUCKET_CHOICE = new Set<ReasonCode>(["BUCKET_TO_ASSIGN", "BUCKET_UNKNOWN", "OWNER_EXCEPTION"]);

/** The prefix recordFailure writes before the error in a qb_needs_finance audit note. */
const ATTEMPT_PREFIX = /^attempt \d+ of \d+: /;

/**
 * The bucket that stops an outboxed, postable expense for a missing QuickBooks Class, or undefined
 * when none does; its name is null for a line with no bucket.
 */
async function missingClass(expense: { id: string; backfill: boolean; qbTxnId: string | null; qbMatchState: string }, ownerIds: (number | null)[]) {
  if (expense.backfill || expense.qbTxnId || !POSTABLE_QB_STATES.includes(expense.qbMatchState)) return undefined;
  if (!(await db.expenseEvent.findFirst({ where: { expenseId: expense.id }, select: { id: true } }))) return undefined;
  if (ownerIds.includes(null)) return { bucketName: null };
  const buckets = new Map((await getExpenseRuntime().budgetOwners.list()).map((b) => [b.id, b]));
  const unclassed = ownerIds.find((id) => id !== null && !buckets.get(id)?.quickBooksClassId);
  return unclassed == null ? undefined : { bucketName: buckets.get(unclassed)?.name ?? null };
}

/**
 * Every open reason on the expense; [] when it is not in this org. `readOnly` is for the queue's
 * reads, which must not freeze the Everyday check.
 */
export async function expenseReasons(principal: ExpensePrincipal, expenseId: string, { readOnly = false } = {}): Promise<QueueReason[]> {
  const expense = await db.expense.findFirst({
    where: { id: expenseId, orgId: await getOrgId() },
    include: {
      receiptReview: { select: { taxReviewRequired: true, reasons: true, approvedTaxCents: true } },
      taxApproval: { select: { taxCents: true } },
      approvals: { select: { status: true, ownerId: true } },
      holds: { where: { status: "PENDING" }, select: { lineItemId: true } },
      flags: { where: OPEN_REVIEWS_WHERE, select: { kind: true, detail: true } },
    },
  });
  if (!expense) return [];
  const open = !CLOSED_STATES.has(expense.state);

  const [boardNeeded, facts, filled] = open
    ? await Promise.all([boardApprovalNeeded(db, expense), signoffFactsByLine(db, expense, { readOnly }), filledSeatsByLine(db, expense.id)])
    : [false, new Map(), new Map()];
  const signerHeld = [...facts].some(([lineId, f]) => blockedSeats(f, filled.get(lineId) ?? []).length > 0);
  const lastFailure =
    expense.qbMatchState === "NEEDS_FINANCE"
      ? await db.expenseAuditLog.findFirst({ where: { expenseId, action: "qb_needs_finance" }, orderBy: { changedAt: "desc" }, select: { notes: true } })
      : null;
  const vendorLinked =
    expense.qbMatchState === "AMBIGUOUS" && expense.needsReimbursement && expense.reimburseePersonId !== null
      ? (await reimburseeVendorId(expense.reimburseePersonId)) !== null
      : null;

  const derived = deriveReasons({
    expense,
    receiptReview: expense.receiptReview,
    approvedTaxCents: expense.taxApproval?.taxCents ?? null,
    approvals: expense.approvals,
    heldLines: new Set(expense.holds.map((h) => h.lineItemId)).size,
    boardApprovalNeeded: boardNeeded,
    signerHeld,
    lastPostError: lastFailure?.notes?.replace(ATTEMPT_PREFIX, "") ?? null,
    reimburseeVendorLinked: vendorLinked,
    missingClass: await missingClass(expense, expense.approvals.map((a) => a.ownerId)),
    openReviews: expense.flags.flatMap((flag) => {
      const kind = reviewKindOf(flag);
      return kind ? [{ kind, detail: flag.detail }] : [];
    }),
  });

  const me = callerId(principal);
  const conflicted = (await conflictedParties(expense)).includes(me);
  const lineFacts = [...facts.values()];
  const actionable = (r: DerivedReason): boolean => {
    if (!principal.isFinance) return false;
    if (BOOKKEEPING.has(r.code) || BUCKET_CHOICE.has(r.code)) return true;
    if (conflicted || r.code === "SIGNER_HELD") return false;
    // A Board member may record the authorization when no finance holder can, but it never counts for them.
    if (r.code === "BOARD_APPROVAL") return !reimburseeUnknown(expense) && boardAuthorizationRefusal(lineFacts, me) === null;
    return true;
  };
  return derived.map((r) => ({ ...r, actionable: actionable(r) }));
}
