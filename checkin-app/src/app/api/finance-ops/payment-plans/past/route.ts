import { handler } from "@/security/handler";
import { programPaymentPlanHistory } from "@/lib/finance/paymentPlanHistory";
import { pageParam } from "@/lib/finance/paymentPlanHistoryPage";

export const GET = handler("GET /api/finance-ops/payment-plans/past", async ({ req }) => ({
    ProgramPaymentPlanDecision: await programPaymentPlanHistory(pageParam(req)),
}));
