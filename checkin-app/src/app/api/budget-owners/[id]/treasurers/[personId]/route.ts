import { handler, badRequest, unauthorized, type HandlerContext } from "@/security/handler";
import { setBucketTreasurer } from "@/lib/finance/budgetOwners";

type Params = { id: string; personId: string };

const setTreasurer = (on: boolean) => async ({ auth, params }: HandlerContext<Params>) => {
    if (auth.type !== "session") throw unauthorized();
    const id = Number(params.id);
    const personId = Number(params.personId);
    if (!Number.isInteger(id) || !Number.isInteger(personId)) throw badRequest("Invalid id");
    return { BudgetOwnerApprover: await setBucketTreasurer(auth.user.id, id, personId, on) };
};

export const PUT = handler<Params>("PUT /api/budget-owners/[id]/treasurers/[personId]", setTreasurer(true));
export const DELETE = handler<Params>("DELETE /api/budget-owners/[id]/treasurers/[personId]", setTreasurer(false));
