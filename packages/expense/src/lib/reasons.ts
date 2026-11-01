// Why an expense waits on finance or the Board, read from the expense's own state. Fixing the
// condition is what clears a reason; only the three reviews are stored rows.
import { taxNeedsFinance, type ReviewKind, type StoredReceiptReview } from "./flags";
import { CLOSED_STATES, reimburseeUnknown } from "./signoff";

/** The Finance review tab a reason sits in, as its `?queue=` value. */
export type QueueTab = "expenses" | "holds" | "qb" | "board";

export type ReasonCode =
  | "BUCKET_TO_ASSIGN"
  | "BUCKET_UNKNOWN"
  | "OWNER_EXCEPTION"
  | "CAPITAL_REVIEW"
  | "DEPRECIATION_CYCLE"
  | "REIMBURSEE_TO_NAME"
  | "TAX_NOT_REVIEWED"
  | "ACCOUNT_HOLD"
  | "QB_POST_FAILED"
  | "QB_AWAITING_MATCH"
  | "QB_UNBOOKED"
  | "QB_VENDOR_MISSING"
  | "QB_NO_CLASS"
  | ReviewKind
  | "BOARD_APPROVAL"
  | "SIGNER_HELD";

/**
 * One open reason: `amountCents` is the tax or the total; `count` the held lines or the failed
 * posts; `detail` the last post error, or a review's stored detail.
 */
export interface QueueReason {
  code: ReasonCode;
  tab: QueueTab;
  actionable: boolean;
  amountCents: number | null;
  count: number | null;
  detail: string | null;
}

export type DerivedReason = Omit<QueueReason, "actionable">;

/** What the derivation reads, gathered by the reason service. */
export interface ReasonFacts {
  expense: {
    state: string;
    backfill: boolean;
    needsReimbursement: boolean;
    reimburseePersonId: number | null;
    taxCents: number;
    receiptTotalCents: number;
    qbMatchState: string;
    qbPostAttempts: number;
  };
  receiptReview: StoredReceiptReview | null;
  /** The tax finance approved on the expense, or null when it approved none. */
  approvedTaxCents: number | null;
  approvals: { status: string; ownerId: number | null }[];
  /** Lines with a pending account-mapping hold. */
  heldLines: number;
  boardApprovalNeeded: boolean;
  /** A seat no one without a conflict can fill. */
  signerHeld: boolean;
  /** The error of the post that used up the retries. */
  lastPostError: string | null;
  /**
   * An outboxed expense the drain stops because a line's bucket has no QuickBooks Class: that
   * bucket's name, or null for a line with no bucket. Undefined when nothing stops it for a Class.
   */
  missingClass?: { bucketName: string | null };
  /** Whether the reimbursee has a linked QuickBooks Vendor; null when there is no reimbursee. */
  reimburseeVendorLinked: boolean | null;
  openReviews: { kind: ReviewKind; detail: string | null }[];
}

/** The tax finance approved covers this expense's tax only when the amounts match. */
export function taxWaitsOnFinance(taxCents: number, review: StoredReceiptReview | null, approvedTaxCents: number | null): boolean {
  return taxNeedsFinance(taxCents, review) && approvedTaxCents !== taxCents;
}

const reason = (code: ReasonCode, tab: QueueTab, fields: Partial<Pick<DerivedReason, "amountCents" | "count" | "detail">> = {}): DerivedReason => ({
  code,
  tab,
  amountCents: fields.amountCents ?? null,
  count: fields.count ?? null,
  detail: fields.detail ?? null,
});

/**
 * Every open reason, in tab order. Expense and Board reasons hold only while the expense is open;
 * QuickBooks reasons hold whatever its state, since a closed expense still posts.
 */
export function deriveReasons(f: ReasonFacts): DerivedReason[] {
  const e = f.expense;
  const open = !CLOSED_STATES.has(e.state);
  const out: DerivedReason[] = [];

  if (open) {
    if (e.state === "assign_ownership" && f.approvals.some((a) => a.ownerId === null)) out.push(reason("BUCKET_TO_ASSIGN", "expenses"));
    if (f.approvals.some((a) => a.status === "unknown")) out.push(reason("BUCKET_UNKNOWN", "expenses"));
    if (f.approvals.some((a) => a.status === "exception_raised")) out.push(reason("OWNER_EXCEPTION", "expenses"));
    if (e.state === "capital_review") out.push(reason("CAPITAL_REVIEW", "expenses"));
    if (e.state === "set_depreciation_cycle") out.push(reason("DEPRECIATION_CYCLE", "expenses"));
    if (reimburseeUnknown(e)) out.push(reason("REIMBURSEE_TO_NAME", "expenses"));
    if (taxWaitsOnFinance(e.taxCents, f.receiptReview, f.approvedTaxCents)) out.push(reason("TAX_NOT_REVIEWED", "expenses", { amountCents: e.taxCents }));
    if (f.heldLines > 0) out.push(reason("ACCOUNT_HOLD", "holds", { count: f.heldLines }));
  }

  if (!e.backfill && e.state !== "rejected") {
    if (e.qbMatchState === "NEEDS_FINANCE") out.push(reason("QB_POST_FAILED", "qb", { count: e.qbPostAttempts, detail: f.lastPostError }));
    if (e.qbMatchState === "UNBOOKED") out.push(reason("QB_UNBOOKED", "qb"));
    if (e.qbMatchState === "AMBIGUOUS") {
      out.push(f.reimburseeVendorLinked === false ? reason("QB_VENDOR_MISSING", "qb") : reason("QB_AWAITING_MATCH", "qb"));
    }
    if (f.missingClass) out.push(reason("QB_NO_CLASS", "qb", { detail: f.missingClass.bucketName }));
  }
  for (const r of f.openReviews) out.push(reason(r.kind, "qb", { detail: r.kind === "QB_DUPLICATE_TO_VOID" ? null : r.detail }));

  if (open) {
    if (f.boardApprovalNeeded) out.push(reason("BOARD_APPROVAL", "board", { amountCents: e.receiptTotalCents }));
    if (f.signerHeld) out.push(reason("SIGNER_HELD", "board"));
  }
  return out;
}
