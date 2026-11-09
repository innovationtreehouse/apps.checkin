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
    await emailBoardMembers("board.paidReject", {
        processId: String(processId),
        actionLink: `${config.baseUrl()}/membership-ops/applications`,
    }, "Paid-reject board ping failed:");
}

/** One-line human description per payment-exception kind, for the board email. */
const EXCEPTION_BLURB: Record<string, string> = {
    PAID_WHILE_BLOCKED: "a household paid but its application is blocked at background check — a refund may be needed",
    NO_ITEM: "a paid order did not contain the membership/program product",
    UNMATCHED_ORDER: "a paid order could not be attributed to an application awaiting payment (no or ambiguous match, a duplicate payment, a payment after the application was closed or certified), or a paid program order can't be shown to come from the named children's own household — nobody was activated",
    REFUND: "a membership/enrollment's order was refunded (an application still waiting on its check is held, not activated)",
    CHARGEBACK: "a chargeback/dispute was filed against an active membership/enrollment's payment",
    CANCELLED: "an active membership/enrollment's order was cancelled",
    REVERSED_BEFORE_ACTIVATION: "a payment was refunded/cancelled before the family was activated",
    AMOUNT_MISMATCH: "a payment does not cover the expected membership fee/price",
    DISCOUNT_UNAUTHORIZED: "an order used a discount its household isn't entitled to (the volunteer code on a non-volunteer membership, or a program member code from another household or an unsettled one)",
    ACTIVE_WITHOUT_PAYMENT: "a membership/enrollment is active with no matching payment on file",
    DENIED_HOUSEHOLD_ACTIVITY: "a household the board denied needs the board: something reached it after the denial (a payment, an approval or an application) and its status was not changed, or, where a program is named, one of its members is enrolled in, volunteers on or leads that program — remove that by hand once the program's leaders know",
    PAYMENT_UNVERIFIABLE: "an active membership/enrollment records a Shopify order that isn't in the mirror — its payment can't be verified",
    DUPLICATE_PAYMENT: "a paid program order bought a seat for someone already enrolled (paid, comped or approved) — a refund may be needed",
    UNCLAIMED_SEATS: "a paid program order bought seats no pending enrollment uses (withdrawn, expired or extra) — money taken, seat unused",
    MIXED_HOUSEHOLDS: "a paid program order names children from more than one household — nobody was activated",
};

/**
 * Escalate a payment reconciliation problem to the board. CRITICAL (a chargeback,
 * or a refund that stops an activation) emails immediately; WARN-level problems are surfaced on the finance-ops payments
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
    await emailBoardMembers("board.paymentException", {
        kind,
        blurb: EXCEPTION_BLURB[kind] ?? "a payment problem was detected",
        exceptionId: String(exceptionId),
        actionLink: `${config.baseUrl()}/finance-ops/payments`,
    }, "Payment-exception board ping failed:");
}
