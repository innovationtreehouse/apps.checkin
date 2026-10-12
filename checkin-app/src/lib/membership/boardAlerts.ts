import { emailBoardMembers } from "@/lib/emailRecipients";
import { config } from "@/lib/config";

/**
 * Board-facing membership email alerts. Kept dependency-free (delegates to the
 * prisma + email + logger only emailRecipients helper) so both the review path
 * (review.ts) and the payment path (payment.ts) can fire them without an import
 * cycle.
 */

/**
 * Email board members that a household which ALREADY PAID did not pass
 * background-check review, so a refund can be arranged out-of-band. Fires in
 * BOTH orderings — a reject after the payment landed (review.ts) and a payment
 * webhook that lands after the reject (payment.ts). (We never move money
 * automatically.)
 */
export async function notifyBoardPaidReject(processId: number): Promise<void> {
    const base = config.baseUrl();
    await emailBoardMembers(
        "Membership: a paid application was blocked at background check",
        `<p>A household that already paid did not pass background-check review (application #${processId}). The membership has <strong>not</strong> been activated and a refund may be needed — please review and contact the household. <a href="${base}/membership-ops/applications">Open applications</a></p>`,
        "Paid-reject board ping failed:",
    );
}

/** One-line human description per payment-exception kind, for the board email. */
const EXCEPTION_BLURB: Record<string, string> = {
    PAID_WHILE_BLOCKED: "a household paid but its application is blocked at background check — a refund may be needed",
    NO_ITEM: "a paid order did not contain the membership/program product",
    UNMATCHED_ORDER: "a paid order could not be attributed to a family (no or ambiguous match)",
    REFUND: "an active membership/enrollment's order was refunded",
    CHARGEBACK: "a chargeback/dispute was filed against an active membership/enrollment's payment",
    CANCELLED: "an active membership/enrollment's order was cancelled",
    REVERSED_BEFORE_ACTIVATION: "a payment was refunded/cancelled before the family was activated",
    AMOUNT_MISMATCH: "a payment does not cover the expected dues/price",
    DISCOUNT_UNAUTHORIZED: "a non-volunteer household's membership order used the volunteer discount code",
    ACTIVE_WITHOUT_PAYMENT: "a membership/enrollment is active with no matching payment on file",
    DENIED_HOUSEHOLD_ACTIVITY: "something happened to a household the board denied (a payment, an approval or an application) — its status was not changed",
    PAYMENT_UNVERIFIABLE: "an active membership/enrollment records a Shopify order that isn't in the mirror — its payment can't be verified",
};

/**
 * Escalate a payment reconciliation problem to the board. CRITICAL (a chargeback)
 * emails immediately; WARN-level problems are surfaced on the finance-ops payments
 * dashboard + the red-dot count only, so a routine refund doesn't put mail in five
 * inboxes. The reconciler that raises these runs once daily, so the dashboard is
 * itself effectively a daily digest — a separate WARN digest email would just be
 * the same list, pushed. Never throws — email failures are swallowed.
 */
export async function notifyBoardPaymentException(
    kind: string,
    severity: "WARN" | "CRITICAL",
    exceptionId: number,
): Promise<void> {
    if (severity !== "CRITICAL") return; // WARN → dashboard + red-dot only.
    const base = config.baseUrl();
    const blurb = EXCEPTION_BLURB[kind] ?? "a payment problem was detected";
    await emailBoardMembers(
        `Payment problem (${kind}) — board action needed`,
        `<p>A payment problem needs the board's attention: ${blurb} (#${exceptionId}). Nothing was changed automatically. <a href="${base}/finance-ops/payments">Open payment problems</a></p>`,
        "Payment-exception board ping failed:",
    );
}
