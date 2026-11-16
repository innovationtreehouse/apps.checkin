import { handler } from "@/security/handler";
import { membershipPaymentPlanHistory } from "@/lib/finance/paymentPlanHistory";
import { archivedParam, pageParam } from "@/lib/finance/paymentPlanHistoryPage";

export const GET = handler("GET /api/finance-ops/membership-payment-plans/past", async ({ req }) => ({
    MembershipPaymentPlanDecision: await membershipPaymentPlanHistory(pageParam(req), archivedParam(req)),
}));
