import { handler } from "@/security/handler";
import { listApproverOptions } from "@/lib/finance/budgetOwners";

export const dynamic = "force-dynamic";

export const GET = handler("GET /api/budget-owners/approver-options", async () => ({
    BudgetOwnerApproverOption: await listApproverOptions(),
}));
