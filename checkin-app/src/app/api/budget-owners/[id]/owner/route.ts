import { handler, badRequest, unauthorized } from "@/security/handler";
import { setBucketOwner } from "@/lib/finance/budgetOwners";

export const PUT = handler<{ id: string }>("PUT /api/budget-owners/[id]/owner", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw badRequest("Invalid bucket id");
    const body = await req.json().catch(() => null);
    const personId: unknown = body && typeof body === "object" ? body.personId : undefined;
    if (personId !== null && (typeof personId !== "number" || !Number.isInteger(personId))) {
        throw badRequest("personId must be an integer or null");
    }
    return { BudgetOwnerApprover: await setBucketOwner(auth.user.id, id, personId) };
});
