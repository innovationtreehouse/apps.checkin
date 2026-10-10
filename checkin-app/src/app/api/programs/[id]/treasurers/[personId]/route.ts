import { handler, badRequest, unauthorized, type HandlerContext } from "@/security/handler";
import { setProgramTreasurer } from "@/lib/finance/budgetOwners";

type Params = { id: string; personId: string };

const setFlag = (on: boolean) => async ({ auth, params }: HandlerContext<Params>) => {
    if (auth.type !== "session") throw unauthorized();
    const programId = Number(params.id);
    const personId = Number(params.personId);
    if (!Number.isInteger(programId) || !Number.isInteger(personId)) throw badRequest("Invalid id");
    return { ProgramVolunteer: await setProgramTreasurer(auth.user.id, programId, personId, on) };
};

export const PUT = handler<Params>("PUT /api/programs/[id]/treasurers/[personId]", setFlag(true));
export const DELETE = handler<Params>("DELETE /api/programs/[id]/treasurers/[personId]", setFlag(false));
