import { describe, expect, it } from "vitest";
import { deriveReasons, taxWaitsOnFinance, type QueueReason, type ReasonFacts } from "../../lib/reasons";
import { REVIEW_KINDS, reviewKindOf } from "../../lib/flags";
import { reasonText } from "../../lib/reasonWords";
import { backToQueue } from "../../lib/backToQueue";

const facts = (over: Partial<Omit<ReasonFacts, "expense">> & { expense?: Partial<ReasonFacts["expense"]> } = {}): ReasonFacts => ({
  receiptReview: null,
  approvedTaxCents: null,
  approvals: [{ status: "approved", ownerId: 7 }],
  heldLines: 0,
  boardApprovalNeeded: false,
  signerHeld: false,
  lastPostError: null,
  reimburseeVendorLinked: null,
  openReviews: [],
  ...over,
  expense: {
    state: "owner_approval",
    backfill: false,
    needsReimbursement: false,
    reimburseePersonId: null,
    taxCents: 0,
    receiptTotalCents: 1000,
    qbMatchState: "UNMATCHED",
    qbPostAttempts: 0,
    ...over.expense,
  },
});
const codes = (f: ReasonFacts) => deriveReasons(f).map((r) => r.code);

describe("deriveReasons", () => {
  it("has nothing for an expense waiting on no one", () => {
    expect(deriveReasons(facts())).toEqual([]);
  });

  it("reads each Expenses-tab reason from the expense's state and approvals", () => {
    expect(codes(facts({ expense: { state: "assign_ownership" }, approvals: [{ status: "pending", ownerId: null }] }))).toEqual(["BUCKET_TO_ASSIGN"]);
    expect(codes(facts({ approvals: [{ status: "unknown", ownerId: null }] }))).toEqual(["BUCKET_UNKNOWN"]);
    expect(codes(facts({ approvals: [{ status: "exception_raised", ownerId: 7 }] }))).toEqual(["OWNER_EXCEPTION"]);
    expect(codes(facts({ expense: { state: "capital_review" } }))).toEqual(["CAPITAL_REVIEW"]);
    expect(codes(facts({ expense: { state: "set_depreciation_cycle" } }))).toEqual(["DEPRECIATION_CYCLE"]);
    expect(codes(facts({ expense: { needsReimbursement: true } }))).toEqual(["REIMBURSEE_TO_NAME"]);
    expect(deriveReasons(facts({ heldLines: 2 }))).toEqual([{ code: "ACCOUNT_HOLD", tab: "accountHolds", amountCents: null, count: 2, detail: null }]);
  });

  it("a known or backfilled reimbursee is no reason", () => {
    expect(codes(facts({ expense: { needsReimbursement: true, reimburseePersonId: 4 } }))).toEqual([]);
    expect(codes(facts({ expense: { needsReimbursement: true, backfill: true } }))).toEqual([]);
  });

  it("tax waits until a receipt or expense approval covers the same amount", () => {
    expect(deriveReasons(facts({ expense: { taxCents: 1240 } }))).toEqual([
      { code: "TAX_NOT_REVIEWED", tab: "expenses", amountCents: 1240, count: null, detail: null },
    ]);
    expect(codes(facts({ expense: { taxCents: 1240 }, approvedTaxCents: 1240 }))).toEqual([]);
    expect(codes(facts({ expense: { taxCents: 1240 }, approvedTaxCents: 1000 }))).toEqual(["TAX_NOT_REVIEWED"]);
    const receiptApproved = { taxReviewRequired: true, reasons: ["tax"], approvedTaxCents: 1240 };
    expect(codes(facts({ expense: { taxCents: 1240 }, receiptReview: receiptApproved }))).toEqual([]);
    expect(codes(facts({ expense: { taxCents: 1240 }, receiptReview: { taxReviewRequired: false, reasons: [], approvedTaxCents: null } }))).toEqual([]);
  });

  it("taxWaitsOnFinance matches the derived reason", () => {
    expect(taxWaitsOnFinance(0, null, null)).toBe(false);
    expect(taxWaitsOnFinance(500, null, null)).toBe(true);
    expect(taxWaitsOnFinance(500, null, 500)).toBe(false);
  });

  it("reads the QuickBooks reasons from qbMatchState, with the last error and the attempts", () => {
    expect(deriveReasons(facts({ expense: { qbMatchState: "NEEDS_FINANCE", qbPostAttempts: 5 }, lastPostError: "Account is inactive" }))).toEqual([
      { code: "QB_POST_FAILED", tab: "quickbooks", amountCents: null, count: 5, detail: "Account is inactive" },
    ]);
    expect(codes(facts({ expense: { qbMatchState: "AMBIGUOUS" } }))).toEqual(["QB_AWAITING_MATCH"]);
    expect(codes(facts({ expense: { qbMatchState: "AMBIGUOUS", needsReimbursement: true, reimburseePersonId: 4 }, reimburseeVendorLinked: false }))).toEqual(["QB_VENDOR_MISSING"]);
    expect(codes(facts({ expense: { qbMatchState: "AMBIGUOUS", needsReimbursement: true, reimburseePersonId: 4 }, reimburseeVendorLinked: true }))).toEqual(["QB_AWAITING_MATCH"]);
  });

  it("a closed expense keeps its QuickBooks reasons and reviews, and drops the rest", () => {
    const closed = facts({
      expense: { state: "qb_complete", qbMatchState: "NEEDS_FINANCE", taxCents: 100, needsReimbursement: true },
      boardApprovalNeeded: true,
      openReviews: [{ kind: "QB_POST_HELD", detail: "closed but not posted: a line is missing a sign-off seat" }],
    });
    expect(codes(closed)).toEqual(["QB_POST_FAILED", "QB_POST_HELD"]);
    expect(codes(facts({ expense: { state: "rejected", qbMatchState: "NEEDS_FINANCE" } }))).toEqual([]);
    expect(codes(facts({ expense: { backfill: true, qbMatchState: "AMBIGUOUS" } }))).toEqual([]);
  });

  it("lists each open review, the duplicate without its raw detail", () => {
    const reviews = deriveReasons(facts({
      openReviews: [
        { kind: "QB_DUPLICATE_TO_VOID", detail: "QuickBooks Purchase 9 is already claimed; the entry posted for this expense needs voiding" },
        { kind: "QB_DRIFT", detail: "amount, accounts" },
      ],
    }));
    expect(reviews.map((r) => [r.code, r.detail])).toEqual([["QB_DUPLICATE_TO_VOID", null], ["QB_DRIFT", "amount, accounts"]]);
  });

  it("reads the Board reasons while the expense is open", () => {
    expect(deriveReasons(facts({ boardApprovalNeeded: true, expense: { receiptTotalCents: 234_000 } }))).toEqual([
      { code: "BOARD_APPROVAL", tab: "board", amountCents: 234_000, count: null, detail: null },
    ]);
    expect(codes(facts({ signerHeld: true }))).toEqual(["SIGNER_HELD"]);
  });
});

describe("reviewKindOf", () => {
  it("names the three reviews, and a QB_POST_FAILED only when its entry needs voiding", () => {
    for (const kind of REVIEW_KINDS) expect(reviewKindOf({ kind, detail: null })).toBe(kind);
    expect(reviewKindOf({ kind: "QB_POST_FAILED", detail: "x; the entry posted for this expense needs voiding" })).toBe("QB_DUPLICATE_TO_VOID");
    expect(reviewKindOf({ kind: "QB_POST_FAILED", detail: "Account is inactive" })).toBeNull();
    expect(reviewKindOf({ kind: "TAX_ATTACHED", detail: null })).toBeNull();
  });
});

describe("reasonText", () => {
  const r = (over: Partial<QueueReason>): QueueReason => ({ code: "CAPITAL_REVIEW", tab: "expenses", actionable: true, amountCents: null, count: null, detail: null, ...over });

  it("words each reason without a code or id", () => {
    expect(reasonText(r({ code: "TAX_NOT_REVIEWED", amountCents: 1240 }), "USD")).toBe("Tax $12.40 not reviewed on the receipt");
    expect(reasonText(r({ code: "BOARD_APPROVAL", amountCents: 234_000 }), "USD")).toBe("Board approval of a $2,340.00 purchase not recorded");
    expect(reasonText(r({ code: "QB_POST_FAILED", count: 5, detail: "Account is inactive" }), "USD")).toBe("Posting failed 5 times: Account is inactive");
    expect(reasonText(r({ code: "QB_DRIFT", detail: "amount, accounts" }), "USD")).toBe("Changed in QuickBooks after posting: amount, account");
    expect(reasonText(r({ code: "QB_POST_HELD", detail: "closed but not posted: a line is missing a sign-off seat" }), "USD"))
      .toBe("Closed but not posted: a line is missing a sign-off seat");
    expect(reasonText(r({ code: "ACCOUNT_HOLD", count: 1 }), "USD")).toBe("1 line has no account rule");
    expect(reasonText(r({ code: "ACCOUNT_HOLD", count: 2 }), "USD")).toBe("2 lines have no account rule");
  });
});

describe("backToQueue", () => {
  it("returns to the queue only when the page came from one and nothing is left for the viewer", () => {
    expect(backToQueue("/finance/review?queue=qb", false)).toBe("/finance/review?queue=qb");
    expect(backToQueue("/finance/review?queue=qb", true)).toBeNull();
    expect(backToQueue(undefined, false)).toBeNull();
    expect(backToQueue(null, false)).toBeNull();
  });
});
