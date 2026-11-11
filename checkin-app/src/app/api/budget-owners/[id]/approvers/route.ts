import { handler, badRequest } from "@/security/handler";
import { listBucketApprovers } from "@/lib/finance/budgetOwners";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>("GET /api/budget-owners/[id]/approvers", async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw badRequest("Invalid bucket id");
    return { BudgetOwnerApprover: await listBucketApprovers(id) };
});
