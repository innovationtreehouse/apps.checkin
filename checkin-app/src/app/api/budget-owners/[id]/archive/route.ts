import { handler, badRequest, unauthorized } from "@/security/handler";
import { archiveBudgetOwner } from "@/lib/finance/budgetOwners";

export const POST = handler<{ id: string }>("POST /api/budget-owners/[id]/archive", async ({ auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw badRequest("Invalid bucket id");
    return { BudgetOwner: await archiveBudgetOwner(auth.user.id, id) };
});
