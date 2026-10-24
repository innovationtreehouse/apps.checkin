import { handler, badRequest, unauthorized } from "@/security/handler";
import { updateBudgetOwner } from "@/lib/finance/budgetOwners";

export const PATCH = handler<{ id: string }>("PATCH /api/budget-owners/[id]", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw badRequest("Invalid bucket id");
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw badRequest("Invalid JSON");
    return { BudgetOwner: await updateBudgetOwner(auth.user.id, id, body) };
});
